import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCompatibleModelFamilies, replayCompatibleMessages } from "../src/replay.ts";

export default function compatibleReplay(pi: ExtensionAPI): void {
	const families = loadCompatibleModelFamilies();

	pi.on("context", (event, ctx) => {
		const target = ctx.model;
		if (!target || families.length === 0) return;

		const assistants: AssistantMessage[] = event.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (assistants.length === 0) return;

		const rewritten = replayCompatibleMessages(assistants, target, families);
		let assistantIndex = 0;
		return {
			messages: event.messages.map((message) =>
				message.role === "assistant" ? rewritten[assistantIndex++] : message,
			),
		};
	});
}
