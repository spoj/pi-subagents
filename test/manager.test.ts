import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentManager, type SubagentSnapshot } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	type Listener = (value: unknown) => void;

	class FakeRpcChild {
		private alive = true;
		private readonly eventListeners = new Set<Listener>();
		private readonly exitListeners = new Set<Listener>();
		readonly prompts: string[] = [];
		abortCalls = 0;
		stopCalls = 0;

		constructor(
			readonly cwd: string,
			readonly sessionFile: string,
			readonly options: unknown,
		) {
			children.push(this);
		}

		isAlive(): boolean {
			return this.alive;
		}

		getStderr(): string {
			return "";
		}

		onEvent(listener: Listener): () => void {
			this.eventListeners.add(listener);
			return () => this.eventListeners.delete(listener);
		}

		onExit(listener: Listener): () => void {
			this.exitListeners.add(listener);
			return () => this.exitListeners.delete(listener);
		}

		async start(): Promise<void> {}

		async prompt(message: string): Promise<void> {
			this.prompts.push(message);
		}

		async steer(message: string): Promise<void> {
			this.prompts.push(message);
		}

		async abort(): Promise<void> {
			this.abortCalls++;
		}

		async stop(): Promise<void> {
			this.stopCalls++;
			this.alive = false;
		}

		emit(event: unknown): void {
			for (const listener of this.eventListeners) listener(event);
		}

		exit(exit: unknown): void {
			this.alive = false;
			for (const listener of this.exitListeners) listener(exit);
		}
	}

	const children: FakeRpcChild[] = [];
	return { children, FakeRpcChild };
});

vi.mock("../src/rpc.ts", () => ({ RpcChild: mocks.FakeRpcChild }));
vi.mock("../src/fork.ts", () => ({
	createForkedSession: () => "/tmp/child.jsonl",
	delegatedTask: (prompt: string, cwd?: string) => (cwd ? `${cwd}: ${prompt}` : prompt),
}));

const context = { cwd: "/tmp/parent", sessionManager: {} } as unknown as ExtensionContext;

function createManager(settled: SubagentSnapshot[] = []): SubagentManager {
	return new SubagentManager({
		onUpdate: () => undefined,
		onSettled: (agent) => settled.push(agent),
	});
}

beforeEach(() => {
	mocks.children.length = 0;
});

describe("subagent manager", () => {
	it("tracks turns, final output, and completion", async () => {
		const settled: SubagentSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", {});
		const child = mocks.children[0];

		child.emit({ type: "turn_start" });
		child.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		child.emit({ type: "agent_settled" });

		expect(started.status).toBe("running");
		expect(manager.list()[0]).toMatchObject({ status: "completed", turns: 1, lastOutput: "done" });
		expect(settled).toHaveLength(1);
	});

	it("reports an unexpected child exit as a failure", async () => {
		const settled: SubagentSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", {});

		mocks.children[0].exit({ code: 1, signal: null });

		expect(manager.list()[0]).toMatchObject({
			id: started.id,
			status: "failed",
			error: "Process exited with 1",
		});
		expect(settled).toHaveLength(1);
	});

	it("stops an active child and settles it once", async () => {
		const settled: SubagentSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", {});
		const child = mocks.children[0];

		const stopped = await manager.stop(started.id);

		expect(stopped.status).toBe("stopped");
		expect(child.abortCalls).toBe(1);
		expect(child.stopCalls).toBe(1);
		expect(settled).toHaveLength(1);
	});

	it("resumes a settled child without creating another process", async () => {
		const manager = createManager();
		const started = await manager.start(context, "first", {});
		const child = mocks.children[0];
		child.emit({ type: "agent_settled" });

		const resumed = await manager.resume(started.id, "second");

		expect(resumed.status).toBe("running");
		expect(mocks.children).toHaveLength(1);
		expect(child.prompts).toEqual(["first", "second"]);
	});
});
