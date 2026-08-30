import { describe, expect, it } from "vitest";
import { RpcChild, type ChildExit } from "../src/rpc.ts";

type RpcChildInternals = {
	process: object | undefined;
	consumeStdout: (chunk: Buffer) => void;
	handleExit: (exit: ChildExit) => void;
	processLine: (line: string) => void;
};

describe("RPC child", () => {
	it("flushes a pending decoder tail when the process exits", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const lines: string[] = [];

		internals.process = {};
		internals.processLine = (line) => lines.push(line);
		internals.consumeStdout(Buffer.from([0xc3]));
		internals.handleExit({ code: 0, signal: null });

		expect(lines).toEqual(["�"]);
	});
});
