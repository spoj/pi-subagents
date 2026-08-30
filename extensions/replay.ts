import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCompatibleModelFamilies, replayCompatibleMessages } from "../src/replay.ts";

export default function compatibleReplay(pi: ExtensionAPI): void {
	const families = loadCompatibleModelFamilies();

	pi.on("context", (event, ctx) => {
		const target = ctx.model;
		if (!target || families.length === 0) return;

		return {
			messages: event.messages.map((message) => {
				if (message.role !== "assistant") return message;
				return replayCompatibleMessages([message], target, families)[0];
			}),
		};
	});
}
