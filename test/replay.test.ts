import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canReplay,
	loadCompatibleModelFamilies,
	modelIdentity,
	replayCompatibleMessages,
} from "../src/replay.ts";

const sol = "github-copilot/openai-responses/gpt-5.6-sol";
const luna = "github-copilot/openai-responses/gpt-5.6-luna";
const other = "github-copilot/openai-responses/grok-4.6";

function assistant(model: string) {
	const [provider, api, id] = model.split("/");
	return {
		role: "assistant" as const,
		provider,
		api: `${api}/${id}`.replace(/\/[^/]+$/, ""),
		model: id,
		content: [{ type: "text" as const, text: "hello" }],
		usage: {} as never,
		stopReason: "stop" as const,
		timestamp: 1,
	};
}

describe("compatible replay", () => {
	it("loads top-level model families from settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-replay-"));
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ replayCompatibleModels: [[sol, luna]] }));

		const families = loadCompatibleModelFamilies(path);
		expect(families).toHaveLength(1);
		expect(families[0].has(sol)).toBe(true);
		expect(families[0].has(luna)).toBe(true);
	});

	it("does not expose or accept malformed family values", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-replay-"));
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ replayCompatibleModels: [[sol, 3], "not-a-family", []] }));

		expect(loadCompatibleModelFamilies(path)).toHaveLength(1);
	});

	it("matches only models in the same family", () => {
		const families = [new Set([sol, luna])];
		expect(canReplay(sol, luna, families)).toBe(true);
		expect(canReplay(sol, other, families)).toBe(false);
	});

	it("rewrites compatible assistant provenance and leaves other messages alone", () => {
		const source = assistant(sol);
		const user = { role: "user" as const, content: "question", timestamp: 1 };
		const target = { provider: "github-copilot", api: "openai-responses", id: "gpt-5.6-luna" };
		const [rewritten] = replayCompatibleMessages([source], target, [new Set([sol, luna])]);

		expect(modelIdentity(rewritten)).toBe(luna);
		expect(rewritten.content).toEqual(source.content);
		expect(replayCompatibleMessages([source], { ...target, id: "grok-4.6" }, [new Set([sol, luna])])).toEqual([source]);
		expect(user).toEqual({ role: "user", content: "question", timestamp: 1 });
	});
});
