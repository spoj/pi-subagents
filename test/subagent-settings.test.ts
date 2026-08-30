import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadSubagentDefaults,
	resolveSubagentOptions,
	THINKING_LEVELS,
} from "../src/subagent-settings.ts";

describe("subagent settings", () => {
	it("loads the dedicated defaults from settings.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-settings-"));
		const path = join(dir, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				defaultSubagentModel: "github-copilot/gpt-5.6-luna",
				defaultSubagentThinkingLevel: "xhigh",
			}),
		);

		expect(loadSubagentDefaults(path)).toEqual({
			model: "github-copilot/gpt-5.6-luna",
			thinkingLevel: "xhigh",
		});
	});

	it("ignores invalid dedicated defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-settings-"));
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ defaultSubagentModel: 42, defaultSubagentThinkingLevel: "deep" }));

		expect(loadSubagentDefaults(path)).toEqual({});
	});

	it("gives direct arguments precedence over dedicated defaults", () => {
		expect(
			resolveSubagentOptions(
				{ model: "provider/direct", thinkingLevel: "low" },
				{ model: "provider/default", thinkingLevel: "high" },
			),
		).toEqual({ model: "provider/direct", thinkingLevel: "low" });
		expect(THINKING_LEVELS).toContain("xhigh");
	});
});
