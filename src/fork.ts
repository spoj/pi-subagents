import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DELEGATED_TASK_PREFIX = `<delegated-task>
This user message marks the fork point. Treat the inherited conversation as reference context, not as a live conversation to continue. Execute only the task below.

Task:
`;

export const DELEGATED_TASK_SUFFIX = "\n</delegated-task>";

export function delegatedTask(prompt: string): string {
	return `${DELEGATED_TASK_PREFIX}${prompt}${DELEGATED_TASK_SUFFIX}`;
}

function isAgentToolCall(message: { role: string; content?: unknown }): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "toolCall" &&
			(block as { name?: unknown }).name === "Agent",
	);
}

export function forkPoint(sessionManager: ExtensionContext["sessionManager"]): string | null {
	const leaf = sessionManager.getLeafEntry();
	if (!leaf || leaf.type !== "message" || !isAgentToolCall(leaf.message)) {
		throw new Error("Agent must run from the current assistant tool call");
	}
	return leaf.parentId;
}

function materializeSession(session: SessionManager, sessionFile: string): void {
	if (existsSync(sessionFile)) return;
	const header = session.getHeader();
	if (!header) throw new Error("Forked session has no session header");

	mkdirSync(dirname(sessionFile), { recursive: true });
	const entries = [header, ...session.getEntries()];
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		flag: "wx",
		mode: 0o600,
	});
}

export function createForkedSession(sessionManager: ExtensionContext["sessionManager"]): string {
	const parentFile = sessionManager.getSessionFile();
	if (!parentFile) throw new Error("Agent requires a persisted parent session");

	const source = SessionManager.open(parentFile);
	const point = forkPoint(sessionManager);
	let childFile: string | undefined;

	if (point) {
		childFile = source.createBranchedSession(point);
	} else {
		const empty = SessionManager.create(source.getCwd(), source.getSessionDir(), {
			parentSession: resolve(parentFile),
		});
		childFile = empty.getSessionFile();
		if (childFile) materializeSession(empty, childFile);
	}

	if (!childFile) throw new Error("Could not create a forked session");
	materializeSession(source, childFile);
	return resolve(childFile);
}

