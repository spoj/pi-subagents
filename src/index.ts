import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForkManager, type ForkSnapshot } from "./manager.ts";
import {
	loadForkDefaults,
	resolveForkOptions,
	THINKING_LEVELS,
	type ForkThinkingLevel,
} from "./fork-settings.ts";

const CHILD_PROCESS = process.env.PI_FORK_CHILD === "1";
const WIDGET_KEY = "pi-tiny-fork";
const DELEGATION_SYSTEM_PROMPT = `You have access to fork tools. Use Fork({ task, cwd: null, model: null, thinkingLevel: null }) by default. Use non-null value for cwd, model, thinkingLevel only when necessary or requested by the user. Use ForkSteer for relevant context or direction that arises after the initial delegation point. If you see a user message containing "<delegated-task>" it marks the task for this delegated fork. Treat the inherited conversation as context and execute only that delegated task. If you are unsure whether this process is a fork, inspect the PI_FORK_CHILD environment variable with the shell; a value of "1" means this is a fork.`;

const forkTool = Type.Object({
	task: Type.String({ description: "Task sent to the forked child" }),
	cwd: Type.Union([
		Type.String({
			description:
				"Working directory for the fork process. Relative paths resolve from the parent working directory; null inherits it",
		}),
		Type.Null(),
	]),
	model: Type.Union([
		Type.String({ description: "Model identifier for the fork; null uses defaultForkModel" }),
		Type.Null(),
	]),
	thinkingLevel: Type.Union([
		StringEnum(THINKING_LEVELS, {
			description: "Thinking level for the fork; null uses defaultForkThinkingLevel",
		}),
		Type.Null(),
	]),
});

const controlTool = Type.Object({
	id: Type.String({ description: "Identifier of the fork to control" }),
	prompt: Type.String({ description: "Task or direction sent to the fork" }),
});

const stopTool = Type.Object({
	id: Type.String({ description: "Identifier of the fork to stop" }),
});

function childToolError(): never {
	throw new Error("Fork orchestration tools are unavailable inside a delegated fork");
}

function renderWidget(ctx: ExtensionContext, manager: ForkManager): void {
	const running = manager.list().filter(isActive).length;
	ctx.ui.setWidget(WIDGET_KEY, running > 0 ? [`${running} forks running`] : undefined);
}

function resultText(fork: ForkSnapshot): string {
	const output = fork.lastOutput?.trim();
	const status = fork.status === "completed" ? "completed" : fork.status;
	return [
		`Fork ${status}.`,
		"",
		`ID: ${fork.id}`,
		`Transcript: ${fork.transcriptPath}`,
		fork.error ? `Error: ${fork.error}` : output ? `Result:\n${output}` : "Result: (no final response; inspect the transcript)",
	].join("\n");
}

function isActive(fork: ForkSnapshot): boolean {
	return fork.status === "starting" || fork.status === "running";
}

function registerTools(pi: ExtensionAPI, manager: ForkManager): void {
	pi.registerTool({
		name: "Fork",
		label: "Fork",
		description:
			"Starts an asynchronous fork that inherits the caller's context up to the point of delegation. A model and thinking level must be selected explicitly or configured with defaultForkModel and defaultForkThinkingLevel.",
		parameters: forkTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (CHILD_PROCESS) childToolError();
			const launchOptions = resolveForkOptions(
				{
					model: params.model ?? undefined,
					thinkingLevel: (params.thinkingLevel ?? undefined) as ForkThinkingLevel | undefined,
				},
				loadForkDefaults(),
			);
			if (!launchOptions.model?.trim()) {
				throw new Error(
					"Fork requires a model. First check which models are available, then ask the user to choose one; do not assume a model. The user can also configure defaultForkModel.",
				);
			}
			if (!launchOptions.thinkingLevel) {
				throw new Error(
					"Fork requires a thinking level: ask the user to choose one or configure defaultForkThinkingLevel; do not assume one.",
				);
			}
			const fork = await manager.start(ctx, params.task, launchOptions, params.cwd ?? undefined);
			return {
				content: [{ type: "text", text: `Fork started.\n\nID: ${fork.id}\nTranscript: ${fork.transcriptPath}` }],
				details: fork,
			};
		},
		renderCall(params, theme) {
			const options = [
				`cwd: ${params.cwd ?? "inherited"}`,
				`model: ${params.model ?? "default"}`,
				`thinking: ${params.thinkingLevel ?? "default"}`,
			];
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Fork"))} ${theme.fg("toolOutput", params.task ?? "")}\n${theme.fg("muted", options.join(" · "))}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "ForkSteer",
		label: "Fork Steer",
		description: "Sends a steering message to a running fork.",
		parameters: controlTool,
		async execute(_toolCallId, params) {
			if (CHILD_PROCESS) childToolError();
			const fork = await manager.steer(params.id, params.prompt);
			return { content: [{ type: "text", text: `Steering sent.\n\nID: ${fork.id}\nTranscript: ${fork.transcriptPath}` }], details: fork };
		},
		renderCall(params, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Fork Steer"))} ${theme.fg("accent", params.id ?? "")}\n${theme.fg("toolOutput", params.prompt ?? "")}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "ForkStop",
		label: "Fork Stop",
		description: "Stops a fork process.",
		parameters: stopTool,
		async execute(_toolCallId, params) {
			if (CHILD_PROCESS) childToolError();
			const fork = await manager.stop(params.id);
			return { content: [{ type: "text", text: `Fork stopped.\n\nID: ${fork.id}\nTranscript: ${fork.transcriptPath}` }], details: fork };
		},
		renderCall(params, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Fork Stop"))} ${theme.fg("accent", params.id ?? "")}`,
				0,
				0,
			);
		},
	});
}

export default function piTinyFork(pi: ExtensionAPI): void {
	let uiContext: ExtensionContext | undefined;
	let manager: ForkManager;
	manager = new ForkManager({
		onUpdate: () => {
			if (uiContext) renderWidget(uiContext, manager);
		},
		onSettled: (fork) => {
			if (CHILD_PROCESS) return;
			pi.sendMessage(
				{
					customType: "pi-tiny-fork",
					content: resultText(fork),
					display: true,
					details: fork,
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
