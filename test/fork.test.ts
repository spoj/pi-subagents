import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createForkedSession, forkPoint } from "../src/fork.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "test",
		api: "openai-responses",
		model: "test-model",
		usage,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function makeSession(withPreviousAssistant = true): SessionManager {
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-cwd-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagents-sessions-"));
	const session = SessionManager.create(cwd, sessionDir);
	session.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	if (withPreviousAssistant) {
		session.appendMessage(assistant([{ type: "text", text: "first answer" }]));
	}
	session.appendMessage({ role: "user", content: "delegate this", timestamp: Date.now() });
	session.appendMessage(
		assistant([
			{
				type: "toolCall",
				id: "call-agent",
				name: "Agent",
				arguments: { prompt: "work" },
			},
		]),
	);
	return session;
}

describe("fork creation", () => {
	it("forks before the current Agent call and preserves the stable prefix", () => {
		const parent = makeSession();
		const childPath = createForkedSession(parent);
		const entries = readFileSync(childPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(entries[0].type).toBe("session");
		expect(entries[0].parentSession).toBe(parent.getSessionFile());
		expect(entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(entries.some((entry) => JSON.stringify(entry).includes("call-agent"))).toBe(false);
	});

	it("materializes a branch that contains no previous assistant response", () => {
		const parent = makeSession(false);
		const childPath = createForkedSession(parent);
		const entries = readFileSync(childPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(entries.at(-1).message.content).toBe("delegate this");
	});

	it("requires the current assistant Agent call", () => {
		const parent = SessionManager.create(mkdtempSync(join(tmpdir(), "pi-subagents-cwd-")), mkdtempSync(join(tmpdir(), "pi-subagents-sessions-")));
		parent.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		expect(() => forkPoint(parent)).toThrow("current assistant tool call");
	});
});
