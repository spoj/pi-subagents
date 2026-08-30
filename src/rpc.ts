import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchOptions } from "./subagent-settings.ts";

type RpcResponse = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type RpcEvent = JsonAgentSessionEvent | {
	type: "extension_ui_request";
	id: string;
	method: string;
};

type PendingRequest = {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 30_000;

export type ChildExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

export type ChildEventListener = (event: RpcEvent) => void;
export type ChildExitListener = (exit: ChildExit) => void;

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (executable === "node" || executable === "node.exe" || executable === "bun" || executable === "bun.exe") {
		return { command: "pi", args };
	}
	return { command: process.execPath, args };
}

export class RpcChild {
	private process: ChildProcess | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<ChildEventListener>();
	private readonly exitListeners = new Set<ChildExitListener>();
	private requestNumber = 0;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private stderr = "";

	constructor(
		private readonly cwd: string,
		private readonly sessionFile: string,
		private readonly options: SubagentLaunchOptions = {},
	) {}

	isAlive(): boolean {
		return this.process !== undefined && this.process.exitCode === null;
	}

	getStderr(): string {
		return this.stderr;
	}

	onEvent(listener: ChildEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: ChildExitListener): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.process) throw new Error("Child process already started");

		const args = ["--mode", "rpc", "--session", this.sessionFile];
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.thinkingLevel) args.push("--thinking", this.options.thinkingLevel);
		const invocation = piInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		child.stdout?.on("data", (chunk: Buffer | string) => this.consumeStdout(chunk));
		child.stdout?.once("end", () => this.flushStdout());
		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderr += chunk.toString();
		});
		child.on("error", (error) => this.rejectPending(error));
		child.stdin?.on("error", (error) => this.rejectPending(new Error(`Subagent stdin error: ${error.message}`)));
		child.once("exit", (code, signal) => this.handleExit({ code, signal }));

		const result = await new Promise<{ error?: Error }>((resolve) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve({});
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				resolve({ error });
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});

		if (result.error) {
			this.process = undefined;
			throw new Error(`Could not start subagent: ${result.error.message}`);
		}
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;

		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) {
				resolve();
				return;
			}

			let forceKillTimeout: NodeJS.Timeout;
			let finishTimeout: NodeJS.Timeout | undefined;
			const finish = () => {
				clearTimeout(forceKillTimeout);
				if (finishTimeout) clearTimeout(finishTimeout);
				resolve();
			};
			child.once("exit", finish);
			forceKillTimeout = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
				finishTimeout = setTimeout(() => {
					if (this.process === child) this.handleExit({ code: null, signal: "SIGKILL" });
					finish();
				}, 1000);
			}, 1000);
			child.kill("SIGTERM");
		});
	}

	async prompt(message: string): Promise<void> {
		await this.request({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.request({ type: "steer", message });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	private async request(command: Record<string, unknown>): Promise<unknown> {
		const child = this.process;
		if (!child || child.exitCode !== null || !child.stdin) throw new Error("Subagent process is not running");

		const id = `pi-subagents-${++this.requestNumber}`;
		let request!: PendingRequest;
		const pending = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pending.get(id) !== request) return;
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}`));
			}, REQUEST_TIMEOUT_MS);
			request = { resolve, reject, timeout };
			this.pending.set(id, request);
		});

		try {
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		} catch (error) {
			if (this.pending.delete(id)) clearTimeout(request.timeout);
			throw error;
		}

		return pending;
	}

	private consumeStdout(chunk: Buffer | string): void {
		this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		if (value.type === "response") {
			const id = typeof value.id === "string" ? value.id : undefined;
			if (!id) return;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			const response = value as unknown as RpcResponse;
			if (response.success) pending.resolve(response.data);
			else pending.reject(new Error(response.error ?? `RPC command failed: ${response.command}`));
			return;
		}

		const event = value as unknown as RpcEvent;
		if (event.type === "extension_ui_request") {
			this.cancelDialog(event);
		}
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Event consumers must not break the protocol reader.
			}
		}
	}

	private cancelDialog(event: Extract<RpcEvent, { type: "extension_ui_request" }>): void {
		if (!this.process?.stdin || !["select", "confirm", "input", "editor"].includes(event.method)) return;
		try {
			this.process.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
		} catch {
			return;
		}
	}

	private flushStdout(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.trim()) this.processLine(this.buffer);
	}

	private handleExit(exit: ChildExit): void {
		if (this.process === undefined) return;
		this.process = undefined;
		const error = new Error(
			`Subagent process exited${exit.code === null ? ` with ${exit.signal ?? "no status"}` : ` with code ${exit.code}`}`,
		);
		this.rejectPending(error);
		for (const listener of this.exitListeners) listener(exit);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
