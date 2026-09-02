# pi-tiny-fork

A tiny Pi extension for running asynchronous child sessions from a stable fork point.

## Design

The model-facing surface is intentionally fixed:

- `Fork({ task, cwd, model, thinkingLevel })` starts a child and returns immediately with its ID, transcript path, and PID. The fields are `task: string`, `cwd: string | null`, `model: string | null`, and `thinkingLevel: ThinkingLevel | null`. Null `model` and `thinkingLevel` use their dedicated `defaultFork*` settings; the fork is refused when either value is unavailable.
- `ForkSteer({ id, prompt })` steers a running child.
- `ForkStop({ id })` stops a running child.

Completed, failed, and stopped children are terminal. Their RPC process tree is terminated, and further work starts a new child with a new ID and transcript. The PID supports best-effort liveness checks, such as `kill -0 PID` on Unix; lifecycle notifications remain authoritative because operating systems can reuse PIDs. Fork processes run in their own process group, so stopping, settling, or shutting down also cleans up descendants.

There is no model listing, agent selector, wait tool, listing tool, workflow language, or model-specific transcript logic. The child is a separate `pi --mode rpc` process using the normal Pi settings and tools.

`cwd` selects an existing directory, such as a Git worktree, for the child. Relative paths are resolved against the parent working directory (`ctx.cwd`). The resolved path is used for both the child process and the forked session. When `cwd` is explicit, the delegated task also tells the child that its working directory was switched to the resolved path. For example:

```json
{
  "task": "Implement and test the feature",
  "cwd": "../feature-worktree",
  "model": null,
  "thinkingLevel": null
}
```

Fork model and thinking-level selection follows this order independently:

1. Non-null `model` or `thinkingLevel` passed to `Fork`.
2. The corresponding `defaultForkModel` or `defaultForkThinkingLevel` in `~/.pi/agent/settings.json`.
3. The fork is refused when either value is unavailable.

Forks do not fall back to model or thinking-level entries persisted in the forked session or to Pi's ordinary defaults.

Each child gets a new session file containing the parent session's path up to the current `Fork` call, then receives a new user message:

```text
<delegated-task>
This user message marks the fork point. Treat the inherited conversation as established reference context, not as a live conversation to continue. Execute only the task below. Do not restate facts, structure, or reasoning already clear from the inherited conversation. Focus on new findings, corrections, implications, and the requested output. If the task requires a self-contained result, include only the minimum inherited background needed.

Task:
...
</delegated-task>
```

The extension appends fork-tool and child-role guidance to the system prompt in both parent and child processes, while the `<delegated-task>` message provides the task-specific context and reporting guidance. It identifies a user message containing `<delegated-task>` as the delegated task marker. All three tools are registered in both processes with identical schemas; a child rejects them only if the model tries to execute one. This keeps the request surface stable while preventing recursive delegation.

When a child settles, the parent immediately receives its status, ID, transcript path, and final text in a steering message. The parent can inspect the full transcripts with Pi's existing `read` tool. A compact human-only widget shows known child activity.

## Context replay

The package contains a separate `replay` extension. It is package-wide: it runs for ordinary Pi sessions as well as fork sessions, even when no fork tool is used. It always uses compatible mode and reads families from the top-level `replayCompatibleModels` setting in `~/.pi/agent/settings.json`:

```json
{
  "defaultForkModel": "github-copilot/gpt-5.6-luna",
  "defaultForkThinkingLevel": "xhigh",
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
pi install git:github.com/spoj/pi-tiny-fork
```

Or run the local checkout temporarily:

```bash
pi -e ./extensions/fork.ts -e ./extensions/replay.ts
```

For normal child spawning, install the package (or configure the package in `~/.pi/agent/settings.json`) so child Pi processes load the same extension. Remove any older standalone `context-replay.ts` extension and `context-replay.json` configuration to avoid duplicate behavior.

## Development

```bash
npm install
npm test
npm run typecheck
```

The package loads two extensions through its manifest: `extensions/fork.ts` for forks and `extensions/replay.ts` for package-wide compatible replay. Implementation lives in `src/`.
