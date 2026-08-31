import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ForkThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ForkLaunchOptions = {
	model?: string;
	thinkingLevel?: ForkThinkingLevel;
};

type Settings = {
	defaultForkModel?: unknown;
	defaultForkThinkingLevel?: unknown;
};

export function loadForkDefaults(settingsPath = join(getAgentDir(), "settings.json")): ForkLaunchOptions {
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
		const defaults: ForkLaunchOptions = {};
		if (typeof settings.defaultForkModel === "string" && settings.defaultForkModel.trim()) {
			defaults.model = settings.defaultForkModel;
		}
		if (
			typeof settings.defaultForkThinkingLevel === "string" &&
			(THINKING_LEVELS as readonly string[]).includes(settings.defaultForkThinkingLevel)
		) {
			defaults.thinkingLevel = settings.defaultForkThinkingLevel as ForkThinkingLevel;
		}
		return defaults;
	} catch {
		return {};
	}
}

export function resolveForkOptions(
	direct: ForkLaunchOptions,
	defaults: ForkLaunchOptions,
): ForkLaunchOptions {
	return {
		model: direct.model ?? defaults.model,
		thinkingLevel: direct.thinkingLevel ?? defaults.thinkingLevel,
	};
}
