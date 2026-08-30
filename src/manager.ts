import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createForkedSession, delegatedTask } from "./fork.ts";
import { RpcChild, type ChildEventListener, type ChildExit } from "./rpc.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchOptions } from "./subagent-settings.ts";

export type SubagentStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export type SubagentSnapshot = {
	id: string;
	transcriptPath: string;
	status: SubagentStatus;
	activity?: string;
	turns: number;
	lastOutput?: string;
	error?: string;
};

type SubagentRecord = SubagentSnapshot & {
	cwd: string;
	cwdExplicit: boolean;
	launchOptions: SubagentLaunchOptions;
	child?: RpcChild;
	lastStopReason?: string;
	stopRequested: boolean;
	settled: boolean;
	operation: Promise<void>;
};

type ManagerOptions = {
	onUpdate: () => void;
	onSettled: (agent: SubagentSnapshot) => void;
};

function newId(existing: Map<string, SubagentRecord>): string {
	let id = "";
	do {
		id = `agent-${randomUUID().slice(0, 8)}`;
	} while (existing.has(id));
	return id;
}

function textFromAssistant(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
	return candidate.content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object") return false;
			const value = block as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string";
		})
		.map((block) => block.text)
		.join("");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SubagentManager {
	private readonly agents = new Map<string, SubagentRecord>();
	private readonly starts = new Set<Promise<unknown>>();
	private shuttingDown = false;

	constructor(private readonly options: ManagerOptions) {}

	list(): SubagentSnapshot[] {
		return Array.from(this.agents.values()).map((agent) => this.snapshot(agent));
	}

	async start(
		ctx: ExtensionContext,
		prompt: string,
		launchOptions: SubagentLaunchOptions,
		cwd?: string,
	): Promise<SubagentSnapshot> {
		if (this.shuttingDown) throw new Error("Subagent manager is shutting down");

		const cwdExplicit = cwd !== undefined;
		const agentCwd = cwdExplicit ? resolve(ctx.cwd, cwd) : ctx.cwd;
		const id = newId(this.agents);
		const transcriptPath = createForkedSession(ctx.sessionManager, cwdExplicit ? agentCwd : undefined, prompt);
		const agent: SubagentRecord = {
			id,
			transcriptPath,
			cwd: agentCwd,
			cwdExplicit,
			launchOptions,
			status: "starting",
			turns: 0,
			stopRequested: false,
			settled: false,
			operation: Promise.resolve(),
		};
		this.agents.set(id, agent);
		this.options.onUpdate();

		agent.settled = false;
		const operation = this.launch(agent, prompt);
		this.starts.add(operation);
		try {
			return await operation;
		} finally {
			this.starts.delete(operation);
		}
	}

	async steer(id: string, prompt: string): Promise<SubagentSnapshot> {
		const agent = this.require(id);
		return this.enqueue(agent, async () => {
			if (agent.status !== "running" || !agent.child?.isAlive()) {
				throw new Error(`${id} is not running; use AgentResume to continue it`);
			}
			await agent.child.steer(prompt);
			return this.snapshot(agent);
		});
	}

	async resume(id: string, prompt: string): Promise<SubagentSnapshot> {
		const agent = this.require(id);
		const operation = this.enqueue(agent, async () => {
			if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
			if (agent.status === "running" || agent.status === "starting") {
				throw new Error(`${id} is already running`);
			}
			agent.stopRequested = false;
			agent.error = undefined;
			agent.lastOutput = undefined;
			agent.lastStopReason = undefined;
			agent.status = "starting";
			agent.activity = undefined;
			agent.settled = false;
			this.options.onUpdate();

			try {
				if (!agent.child?.isAlive()) {
					await this.startProcess(agent);
					if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
				}
				agent.status = "running";
				this.options.onUpdate();
				await agent.child!.prompt(delegatedTask(prompt, agent.cwdExplicit ? agent.cwd : undefined));
				return this.snapshot(agent);
			} catch (error) {
				agent.stopRequested = true;
				if (agent.child?.isAlive()) await agent.child.stop().catch(() => undefined);
				agent.stopRequested = false;
				this.fail(agent, errorText(error));
				if (!this.shuttingDown) this.settle(agent);
				throw new Error(`Could not resume ${id}: ${errorText(error)}`);
			}
		});
		this.starts.add(operation);
		try {
			return await operation;
		} finally {
			this.starts.delete(operation);
		}
	}

	async stop(id: string): Promise<SubagentSnapshot> {
		const agent = this.require(id);
		return this.enqueue(agent, async () => {
			const wasActive = agent.status === "starting" || agent.status === "running";
			agent.stopRequested = true;
			if (agent.child?.isAlive()) {
				void agent.child.abort().catch(() => undefined);
				await agent.child.stop();
			}
			agent.status = "stopped";
			agent.activity = undefined;
			this.options.onUpdate();
			if (wasActive && !this.shuttingDown) this.settle(agent);
			return this.snapshot(agent);
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.all([
			...Array.from(this.agents.values()).map(async (agent) => {
				agent.stopRequested = true;
				if (agent.child?.isAlive()) await agent.child.stop();
			}),
			...Array.from(this.agents.values(), (agent) => agent.operation),
			...Array.from(this.starts, (start) => start.catch(() => undefined)),
		]);
	}

	private async launch(agent: SubagentRecord, prompt: string): Promise<SubagentSnapshot> {
		try {
			await this.startProcess(agent);
			if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
			agent.status = "running";
			this.options.onUpdate();
			await agent.child!.prompt(delegatedTask(prompt, agent.cwdExplicit ? agent.cwd : undefined));
			return this.snapshot(agent);
		} catch (error) {
			agent.stopRequested = true;
			if (agent.child?.isAlive()) await agent.child.stop().catch(() => undefined);
			agent.stopRequested = false;
			this.fail(agent, errorText(error));
			if (!this.shuttingDown) this.settle(agent);
			throw new Error(`Could not start ${agent.id}: ${errorText(error)}`);
		}
	}

	private async startProcess(agent: SubagentRecord): Promise<void> {
		const child = new RpcChild(agent.cwd, agent.transcriptPath, agent.launchOptions);
		agent.child = child;
		child.onEvent(this.eventListener(agent));
		child.onExit((exit) => this.handleExit(agent, child, exit));
		await child.start();
	}

	private eventListener(agent: SubagentRecord): ChildEventListener {
		return (event) => {
			if (this.shuttingDown) return;
			switch (event.type) {
				case "turn_start":
					agent.turns++;
					agent.status = "running";
					break;
				case "tool_execution_start":
					agent.activity = event.toolName;
					break;
				case "tool_execution_end":
					if (agent.activity === event.toolName) agent.activity = undefined;
					break;
				case "message_end":
					if (event.message.role === "assistant") {
						agent.lastOutput = textFromAssistant(event.message) || undefined;
						agent.lastStopReason = event.message.stopReason;
						agent.error = event.message.errorMessage;
					}
					break;
				case "agent_settled":
					if (!agent.stopRequested && !agent.settled) {
						if (agent.lastStopReason === "error" || agent.lastStopReason === "aborted") {
							agent.status = "failed";
							agent.error = agent.error ?? "Subagent stopped with an error";
						} else {
							agent.status = "completed";
						}
						agent.activity = undefined;
						this.settle(agent);
					}
					break;
			}
			this.options.onUpdate();
		};
	}

	private handleExit(agent: SubagentRecord, child: RpcChild, exit: ChildExit): void {
		if (agent.child !== child || this.shuttingDown || agent.stopRequested) return;
		if (agent.status === "completed" || agent.status === "failed") return;
		agent.status = "failed";
		agent.activity = undefined;
		agent.error = child.getStderr().trim() || `Process exited with ${exit.code ?? exit.signal ?? "no status"}`;
		this.options.onUpdate();
		this.settle(agent);
	}

	private settle(agent: SubagentRecord): void {
		if (agent.settled) return;
		agent.settled = true;
		this.options.onSettled(this.snapshot(agent));
	}

	private fail(agent: SubagentRecord, message: string): void {
		agent.status = "failed";
		agent.activity = undefined;
		agent.error = message;
		this.options.onUpdate();
	}

	private require(id: string): SubagentRecord {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Unknown subagent: ${id}`);
		return agent;
	}

	private enqueue<T>(agent: SubagentRecord, operation: () => Promise<T>): Promise<T> {
		const next = agent.operation.then(operation, operation);
		agent.operation = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private snapshot(agent: SubagentRecord): SubagentSnapshot {
		return {
			id: agent.id,
			transcriptPath: agent.transcriptPath,
			status: agent.status,
			...(agent.activity ? { activity: agent.activity } : {}),
			turns: agent.turns,
			...(agent.lastOutput ? { lastOutput: agent.lastOutput } : {}),
			...(agent.error ? { error: agent.error } : {}),
		};
	}
}
