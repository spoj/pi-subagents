import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	let managerOptions: { onSettled: (agent: SubagentSnapshot) => void } | undefined;

	class FakeManager {
		constructor(options: typeof managerOptions) {
			managerOptions = options;
		}

		list() {
			return [{ status: "running" }];
		}
	}

	return {
		FakeManager,
		get managerOptions() {
			return managerOptions;
		},
	};
});

vi.mock("../src/manager.ts", () => ({ SubagentManager: mocks.FakeManager }));

const originalChildFlag = process.env.PI_SUBAGENT_CHILD;

afterEach(() => {
	if (originalChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = originalChildFlag;
	vi.resetModules();
});

describe("subagent tools", () => {
	it("exposes task and flat nullable options", async () => {
		delete process.env.PI_SUBAGENT_CHILD;
		const { default: piSubagents } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piSubagents(pi as never);
		const agentTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "Agent")?.[0];
		const properties = agentTool.parameters.properties;

		expect(properties).toHaveProperty("task");
		expect(properties).not.toHaveProperty("advanced_options");
		expect(properties).not.toHaveProperty("prompt");
		expect(properties).toEqual(
			expect.objectContaining({ model: expect.any(Object), thinkingLevel: expect.any(Object), cwd: expect.any(Object) }),
		);
		expect(agentTool.parameters.required).toEqual(["task", "cwd", "model", "thinkingLevel"]);
		expect(properties.cwd.anyOf).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "string" }), { type: "null" }]),
		);
		expect(properties.model.anyOf).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "string" }), { type: "null" }]),
		);
		expect(properties.thinkingLevel.anyOf).toEqual(expect.arrayContaining([{ type: "null" }]));
	});

	it("delivers each settled result while sibling agents are still active", async () => {
		delete process.env.PI_SUBAGENT_CHILD;
		const { default: piSubagents } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piSubagents(pi as never);
		const agent: SubagentSnapshot = {
			id: "agent-1",
			transcriptPath: "/tmp/agent-1.jsonl",
			status: "completed",
			turns: 1,
			lastOutput: "done",
		};
		mocks.managerOptions?.onSettled(agent);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage.mock.calls[0][0].content).toContain("done");
	});
});
