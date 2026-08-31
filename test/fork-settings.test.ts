import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadForkDefaults,
	resolveForkOptions,
	THINKING_LEVELS,
} from "../src/fork-settings.ts";

describe("fork settings", () => {
	it("loads the dedicated defaults from settings.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tiny-fork-settings-"));
		const path = join(dir, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				defaultForkModel: "github-copilot/gpt-5.6-luna",
				defaultForkThinkingLevel: "xhigh",
			}),
		);

		expect(loadForkDefaults(path)).toEqual({
			model: "github-copilot/gpt-5.6-luna",
			thinkingLevel: "xhigh",
		});
	});

	it("ignores invalid dedicated defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tiny-fork-settings-"));
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ defaultForkModel: 42, defaultForkThinkingLevel: "deep" }));

		expect(loadForkDefaults(path)).toEqual({});
	});

	it("gives direct arguments precedence over dedicated defaults", () => {
		expect(
			resolveForkOptions(
				{ model: "provider/direct", thinkingLevel: "low" },
				{ model: "provider/default", thinkingLevel: "high" },
			),
		).toEqual({ model: "provider/direct", thinkingLevel: "low" });
		expect(THINKING_LEVELS).toContain("xhigh");
	});
});
