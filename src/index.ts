import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentManager, type SubagentSnapshot } from "./manager.ts";
import {
	loadSubagentDefaults,
	resolveSubagentOptions,
	THINKING_LEVELS,
	type SubagentThinkingLevel,
} from "./subagent-settings.ts";

const CHILD_PROCESS = process.env.PI_SUBAGENT_CHILD === "1";
const WIDGET_KEY = "pi-subagents";

const agentTool = Type.Object({
	model: Type.Optional(Type.String({ description: "Optional model pattern for the subagent" })),
	thinkingLevel: Type.Optional(
		StringEnum(THINKING_LEVELS, { description: "Optional thinking level for the subagent" }),
	),
	prompt: Type.String({ description: "The task for the forked subagent to execute" }),
});

const controlTool = Type.Object({
	id: Type.String({ description: "The subagent ID returned by Agent" }),
	prompt: Type.String({ description: "The new direction or task" }),
});

const stopTool = Type.Object({
	id: Type.String({ description: "The subagent ID returned by Agent" }),
});

type AgentDetails = SubagentSnapshot;

function childToolError(): never {
	throw new Error("Subagent orchestration tools are unavailable inside a delegated subagent");
}

function renderWidget(ctx: ExtensionContext, manager: SubagentManager): void {
	const running = manager.list().filter((agent) => agent.status === "starting" || agent.status === "running").length;
	ctx.ui.setWidget(WIDGET_KEY, running > 0 ? [`${running} agents running`] : undefined);
}

function resultText(agent: SubagentSnapshot): string {
	const output = agent.lastOutput?.trim();
	const status = agent.status === "completed" ? "completed" : agent.status;
	return [
		`Subagent ${status}.`,
		"",
		`ID: ${agent.id}`,
		`Transcript: ${agent.transcriptPath}`,
		agent.error ? `Error: ${agent.error}` : output ? `Result:\n${output}` : "Result: (no final response; inspect the transcript)",
	].join("\n");
}

function registerTools(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: "Start an asynchronous subagent in a stable fork of this session. The result includes its ID and transcript path.",
		parameters: agentTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (CHILD_PROCESS) childToolError();
			const launchOptions = resolveSubagentOptions(
				{
					model: params.model,
					thinkingLevel: params.thinkingLevel as SubagentThinkingLevel | undefined,
				},
				loadSubagentDefaults(),
			);
			const agent = await manager.start(ctx, params.prompt, launchOptions);
			return {
				content: [{ type: "text", text: `Subagent started.\n\nID: ${agent.id}\nTranscript: ${agent.transcriptPath}` }],
				details: agent,
			};
		},
	});

	pi.registerTool({
		name: "AgentSteer",
		label: "Agent Steer",
		description: "Send a steering message to a running subagent.",
		parameters: controlTool,
		async execute(_toolCallId, params) {
			if (CHILD_PROCESS) childToolError();
			const agent = await manager.steer(params.id, params.prompt);
			return { content: [{ type: "text", text: `Steering sent.\n\nID: ${agent.id}\nTranscript: ${agent.transcriptPath}` }], details: agent };
		},
	});

	pi.registerTool({
		name: "AgentResume",
		label: "Agent Resume",
		description: "Resume a completed, stopped, or failed subagent with a new task.",
		parameters: controlTool,
		async execute(_toolCallId, params) {
			if (CHILD_PROCESS) childToolError();
			const agent = await manager.resume(params.id, params.prompt);
			return { content: [{ type: "text", text: `Subagent resumed.\n\nID: ${agent.id}\nTranscript: ${agent.transcriptPath}` }], details: agent };
		},
	});

	pi.registerTool({
		name: "AgentStop",
		label: "Agent Stop",
		description: "Stop a subagent process.",
		parameters: stopTool,
		async execute(_toolCallId, params) {
			if (CHILD_PROCESS) childToolError();
			const agent = await manager.stop(params.id);
			return { content: [{ type: "text", text: `Subagent stopped.\n\nID: ${agent.id}\nTranscript: ${agent.transcriptPath}` }], details: agent };
		},
	});
}

export default function piSubagents(pi: ExtensionAPI): void {
	let uiContext: ExtensionContext | undefined;
	const manager = new SubagentManager({
		onUpdate: () => {
			if (uiContext) renderWidget(uiContext, manager);
		},
		onSettled: (agent) => {
			if (CHILD_PROCESS) return;
			pi.sendMessage(
				{
					customType: "pi-subagents",
					content: resultText(agent),
					display: true,
					details: agent,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});

	registerTools(pi, manager);

	pi.on("session_start", (_event, ctx) => {
		uiContext = ctx;
		renderWidget(ctx, manager);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		await manager.shutdown();
		uiContext = undefined;
	});
}

export { createForkedSession, forkPoint } from "./fork.ts";
export { canReplay, loadCompatibleModelFamilies, modelIdentity, replayCompatibleMessages } from "./replay.ts";
export { SubagentManager } from "./manager.ts";
export type { AgentDetails };
