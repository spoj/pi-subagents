# pi-subagents

A small Pi extension for asynchronous subagents that always run in a stable session fork.

## Design

The model-facing surface is intentionally fixed:

- `Agent({ task, cwd, model, thinkingLevel })` starts a child and returns immediately with its ID and transcript path. Set `cwd`, `model`, and `thinkingLevel` to `null` unless needed.
- `AgentSteer({ id, prompt })` steers a running child.
- `AgentResume({ id, prompt })` continues a stopped, failed, or completed child.
- `AgentStop({ id })` stops a child.

There is no model listing, agent selector, wait tool, listing tool, workflow language, or model-specific transcript logic. The child is a separate `pi --mode rpc` process using the normal Pi settings and tools.

`cwd` selects an existing directory, such as a Git worktree, for the child. Relative paths are resolved against the parent working directory (`ctx.cwd`). The resolved path is used for both the child process and the forked session, and is retained when the child is resumed. When `cwd` is explicit, the delegated task also tells the child that its working directory was switched to the resolved path. For example:

```json
{
  "task": "Implement and test the feature",
  "cwd": "../feature-worktree",
  "model": null,
  "thinkingLevel": null
}
```

Subagent model selection follows this order:

1. `model` and `thinkingLevel` passed to `Agent`.
2. `defaultSubagentModel` and `defaultSubagentThinkingLevel` in `~/.pi/agent/settings.json`.
3. Model and thinking-level entries persisted in the forked session.
4. Pi's ordinary `defaultModel`, `defaultProvider`, and thinking-level settings.

Each child gets a new session file containing the parent session's path up to the current `Agent` call, then receives a new user message:

```text
<delegated-task>
This user message marks the fork point. Treat the inherited conversation as reference context, not as a live conversation to continue. Execute only the task below.

Task:
...
</delegated-task>
```

The extension appends the same delegation guidance to the system prompt in both parent and child processes. It identifies a user message containing `<delegated-task>` as the delegated task marker. All four tools are registered in both processes with identical schemas; a child rejects them only if the model tries to execute one. This keeps the request surface stable while preventing recursive delegation.

When a child settles, the parent immediately receives its status, ID, transcript path, and final text in a steering message. The parent can inspect the full transcripts with Pi's existing `read` tool. A compact human-only widget shows known child activity.

## Context replay

The package contains a separate `replay` extension. It is package-wide: it runs for ordinary Pi sessions as well as subagent sessions, even when no subagent tool is used. It always uses compatible mode and reads families from the top-level `replayCompatibleModels` setting in `~/.pi/agent/settings.json`:

```json
{
  "defaultSubagentModel": "github-copilot/gpt-5.6-luna",
  "defaultSubagentThinkingLevel": "xhigh",
  "replayCompatibleModels": [
    [
      "github-copilot/openai-responses/gpt-5.6-sol",
      "github-copilot/openai-responses/gpt-5.6-luna"
    ]
  ]
}
```

Assistant-message provenance is rewritten only within a configured family. Pi remains responsible for converting the resulting transcript into the target provider's request format.

## Install

From GitHub:

```bash
pi install git:github.com/spoj/pi-subagents
```

Or run the local checkout temporarily:

```bash
pi -e ./extensions/subagents.ts -e ./extensions/replay.ts
```

For normal child spawning, install the package (or configure the package in `~/.pi/agent/settings.json`) so child Pi processes load the same extension. Remove any older standalone `context-replay.ts` extension and `context-replay.json` configuration to avoid duplicate behavior.

## Development

```bash
npm install
npm test
npm run typecheck
```

The package loads two extensions through its manifest: `extensions/subagents.ts` for subagents and `extensions/replay.ts` for package-wide compatible replay. Implementation lives in `src/`.
