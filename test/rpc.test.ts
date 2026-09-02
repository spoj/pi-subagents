import { describe, expect, it, vi } from "vitest";
import { RpcChild, type ChildExit } from "../src/rpc.ts";

type RpcChildInternals = {
	process: object | undefined;
	pid: number;
	consumeStdout: (chunk: Buffer) => void;
	flushStdout: () => void;
	handleExit: (exit: ChildExit) => void;
	processLine: (line: string) => void;
};

describe("RPC child", () => {
	it("flushes a pending decoder tail when stdout ends", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const lines: string[] = [];

		internals.process = {};
		internals.processLine = (line) => lines.push(line);
		internals.consumeStdout(Buffer.from([0xc3]));
		internals.flushStdout();

		expect(lines).toEqual(["�"]);
	});

	it("retains the spawned process ID after exit", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		internals.pid = 1234;
		internals.process = { exitCode: null };

		internals.handleExit({ code: 0, signal: null });

		expect(child.getPid()).toBe(1234);
	});

	it("stops tracking a child when it exits before its stdio closes", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		internals.process = { exitCode: null };

		internals.handleExit({ code: 1, signal: null });

		expect(child.isAlive()).toBe(false);
	});

	it("ignores events after the child exits", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const events: unknown[] = [];
		child.onEvent((event) => events.push(event));
		internals.process = {};
		internals.handleExit({ code: 1, signal: null });

		internals.processLine(JSON.stringify({ type: "turn_start" }));

		expect(events).toEqual([]);
	});

	it("stops the process group after the leader has exited", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === 0) {
				const error = new Error("group still exists") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return true;
		}) as never);
		try {
			const child = new RpcChild("/tmp", "/tmp/session.jsonl");
			const internals = child as unknown as RpcChildInternals;
			internals.pid = 1234;
			internals.process = undefined;

			const stopping = child.stop();
			await vi.advanceTimersByTimeAsync(1000);
			await stopping;

			expect(kill.mock.calls.map(([pid, signal]) => [pid, signal]).filter(([, signal]) => signal !== 0)).toEqual([
				[-1234, "SIGTERM"],
				[-1234, "SIGKILL"],
			]);
		} finally {
			kill.mockRestore();
			vi.useRealTimers();
		}
	});

	it("resolves stop after a forced kill even if stdio never closes", async () => {
		vi.useFakeTimers();
		try {
			const child = new RpcChild("/tmp", "/tmp/session.jsonl");
			const internals = child as unknown as RpcChildInternals;
			const signals: NodeJS.Signals[] = [];
			internals.process = {
				exitCode: null,
				once: () => undefined,
				kill: (signal: NodeJS.Signals) => signals.push(signal),
			} as never;

			const stopping = child.stop();
			await vi.advanceTimersByTimeAsync(1000);
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
			await vi.advanceTimersByTimeAsync(1000);
			await stopping;
			expect(child.isAlive()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
