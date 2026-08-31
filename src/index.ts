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
const DELEGATION_SYSTEM_PROMPT = `You have access to subagent tools. Use Agent({ task, cwd: null, model: null, thinkingLevel: null }) by default. Set cwd, model, or thinkingLevel to a non-null value only when necessary or requested by the user. If you see a user message containing "<delegated-task>" it marks the task for this delegated subagent. Treat the inherited conversation as context and execute only that delegated task. Avoid repeating or over-explaining context already clear from the inherited conversation. If you are unsure whether this process is a subagent, inspect the PI_SUBAGENT_CHILD environment variable with the shell; a value of "1" means this is a subagent.`;

const agentTool = Type.Object({
	task: Type.String({ description: "Task sent to the forked subagent" }),
	cwd: Type.Union([
		Type.String({
			description:
				"Working directory for the subagent process. Relative paths resolve from the parent working directory; null inherits it",
		}),
		Type.Null(),
	]),
	model: Type.Union([
		Type.String({ description: "Model identifier for the subagent; null uses the configured default" }),
		Type.Null(),
	]),
	thinkingLevel: Type.Union([
		StringEnum(THINKING_LEVELS, {
			description: "Thinking level for the subagent; null uses the configured default",
		}),
		Type.Null(),
	]),
});

const controlTool = Type.Object({
	id: Type.String({ description: "Identifier of the subagent to control" }),
	prompt: Type.String({ description: "Task or direction sent to the subagent" }),
});

const stopTool = Type.Object({
	id: Type.String({ description: "Identifier of the subagent to stop" }),
});

function childToolError(): never {
	throw new Error("Subagent orchestration tools are unavailable inside a delegated subagent");
}

function renderWidget(ctx: ExtensionContext, manager: SubagentManager): void {
	const running = manager.list().filter(isActive).length;
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

function isActive(agent: SubagentSnapshot): boolean {
	return agent.status === "starting" || agent.status === "running";
}

function registerTools(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description:
			"Starts an asynchronous subagent that inherits the caller's context up to the point of delegation, and returns its ID and transcript path.",
		parameters: agentTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (CHILD_PROCESS) childToolError();
			const launchOptions = resolveSubagentOptions(
				{
					model: params.model ?? undefined,
					thinkingLevel: (params.thinkingLevel ?? undefined) as SubagentThinkingLevel | undefined,
				},
				loadSubagentDefaults(),
			);
			const agent = await manager.start(ctx, params.task, launchOptions, params.cwd ?? undefined);
			return {
				content: [{ type: "text", text: `Subagent started.\n\nID: ${agent.id}\nTranscript: ${agent.transcriptPath}` }],
				details: agent,
			};
		},
	});

	pi.registerTool({
		name: "AgentSteer",
		label: "Agent Steer",
		description: "Sends a steering message to a running subagent.",
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
		description: "Resumes a completed, stopped, or failed subagent with a new task.",
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
		description: "Stops a subagent process.",
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
	let manager: SubagentManager;
	manager = new SubagentManager({
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
				{ deliverAs: "steer", triggerTurn: true },
			);
		},
	});

	registerTools(pi, manager);

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${DELEGATION_SYSTEM_PROMPT}`,
	}));

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
