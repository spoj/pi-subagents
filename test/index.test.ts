import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForkSnapshot } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	let managerOptions: { onSettled: (fork: ForkSnapshot) => void } | undefined;
	const startCalls: Array<{
		ctx: unknown;
		prompt: string;
		launchOptions: { model?: string; thinkingLevel?: string };
		cwd?: string;
	}> = [];

	class FakeManager {
		constructor(options: typeof managerOptions) {
			managerOptions = options;
		}

		list() {
			return [{ status: "running" }];
		}

		async start(
			ctx: unknown,
			prompt: string,
			launchOptions: { model?: string; thinkingLevel?: string },
			cwd?: string,
		) {
			startCalls.push({ ctx, prompt, launchOptions, cwd });
			return { id: "fork-1", transcriptPath: "/tmp/fork-1.jsonl", status: "starting", turns: 0 };
		}
	}

	return {
		FakeManager,
		startCalls,
		get managerOptions() {
			return managerOptions;
		},
	};
});

vi.mock("../src/manager.ts", () => ({ ForkManager: mocks.FakeManager }));

const originalChildFlag = process.env.PI_FORK_CHILD;

afterEach(() => {
	if (originalChildFlag === undefined) delete process.env.PI_FORK_CHILD;
	else process.env.PI_FORK_CHILD = originalChildFlag;
	mocks.startCalls.length = 0;
	vi.resetModules();
});

describe("fork tools", () => {
	it("exposes task and flat nullable options", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const toolNames = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		const forkTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "Fork")?.[0];
		const properties = forkTool.parameters.properties;

		expect(toolNames).toEqual(["Fork", "ForkSteer", "ForkStop"]);

		expect(properties).toHaveProperty("task");
		expect(properties).not.toHaveProperty("advanced_options");
		expect(properties).not.toHaveProperty("prompt");
		expect(properties).toEqual(
			expect.objectContaining({ model: expect.any(Object), thinkingLevel: expect.any(Object), cwd: expect.any(Object) }),
		);
		expect(forkTool.parameters.required).toEqual(["task", "cwd", "model", "thinkingLevel"]);
		expect(properties.cwd.anyOf).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "string" }), { type: "null" }]),
		);
		expect(properties.model.anyOf).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "string" }), { type: "null" }]),
		);
		expect(properties.thinkingLevel.anyOf).toEqual(expect.arrayContaining([{ type: "null" }]));
	});

	it("renders fork tool arguments", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};

		piTinyFork(pi as never);
		const tools = Object.fromEntries(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
		const fork = tools.Fork.renderCall(
			{ task: "inspect rendering", cwd: null, model: null, thinkingLevel: null },
			theme as never,
			{} as never,
		);
		const steer = tools.ForkSteer.renderCall(
			{ id: "fork-1234", prompt: "check the tests" },
			theme as never,
			{} as never,
		);
		const stop = tools.ForkStop.renderCall({ id: "fork-1234" }, theme as never, {} as never);
		const rendered = (component: { render: (width: number) => string[] }) =>
			component.render(200).map((line) => line.trimEnd()).join("\n");

		expect(rendered(fork)).toContain("Fork inspect rendering\ncwd: inherited · model: default · thinking: default");
		expect(rendered(steer)).toContain("Fork Steer fork-1234\ncheck the tests");
		expect(rendered(stop)).toContain("Fork Stop fork-1234");
	});

	it("tells delegators to build on inherited context", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const handler = pi.on.mock.calls.find(([event]) => event === "before_agent_start")?.[1];
		const result = handler({ systemPrompt: "base prompt" });

		expect(result.systemPrompt).toContain("base prompt");
		expect(result.systemPrompt).toContain("ask for the incremental output needed, not a recap");
	});

	it("normalizes null options before starting", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const forkTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "Fork")?.[0];
		await forkTool.execute(
			"call-1",
			{ task: "check defaults", cwd: null, model: null, thinkingLevel: null },
			undefined,
			undefined,
			{} as never,
		);

		expect(mocks.startCalls).toHaveLength(1);
		expect(mocks.startCalls[0]).toMatchObject({ prompt: "check defaults", cwd: undefined });
		expect(mocks.startCalls[0].launchOptions).not.toEqual(
			expect.objectContaining({ model: null, thinkingLevel: null }),
		);
	});

	it("delivers each settled result while sibling forks are still active", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const fork: ForkSnapshot = {
			id: "fork-1",
			transcriptPath: "/tmp/fork-1.jsonl",
			status: "completed",
			turns: 1,
			lastOutput: "done",
		};
		mocks.managerOptions?.onSettled(fork);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage.mock.calls[0][0].content).toContain("done");
	});
});
