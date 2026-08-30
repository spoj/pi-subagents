import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number];

export type SubagentLaunchOptions = {
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
};

type Settings = {
	defaultSubagentModel?: unknown;
	defaultSubagentThinkingLevel?: unknown;
};

export function loadSubagentDefaults(settingsPath = join(getAgentDir(), "settings.json")): SubagentLaunchOptions {
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
		const defaults: SubagentLaunchOptions = {};
		if (typeof settings.defaultSubagentModel === "string" && settings.defaultSubagentModel.trim()) {
			defaults.model = settings.defaultSubagentModel;
		}
		if (
			typeof settings.defaultSubagentThinkingLevel === "string" &&
			(THINKING_LEVELS as readonly string[]).includes(settings.defaultSubagentThinkingLevel)
		) {
			defaults.thinkingLevel = settings.defaultSubagentThinkingLevel as SubagentThinkingLevel;
		}
		return defaults;
	} catch {
		return {};
	}
}

export function resolveSubagentOptions(
	direct: SubagentLaunchOptions,
	defaults: SubagentLaunchOptions,
): SubagentLaunchOptions {
	return {
		model: direct.model ?? defaults.model,
		thinkingLevel: direct.thinkingLevel ?? defaults.thinkingLevel,
	};
}
