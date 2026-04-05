# Architecture

This adapter is built around the same engineering principles that make the mature Paperclip adapters maintainable:

- **pure planning before side effects**
- **narrow, testable parsing helpers**
- **explicit environment construction**
- **host/runtime separation**
- **adapter-visible docs embedded in code**

## Main server flow

The runtime entrypoint is `src/server/execute.js`.

High-level lifecycle:

1. normalize adapter config
2. detect model/provider defaults from Hermes config when not explicitly set
3. derive the effective working directory
4. build a Paperclip-aware wake prompt
5. construct the Hermes CLI argument vector
6. construct a bounded child environment
7. emit `onMeta` and `onSpawn` for host observability
8. spawn Hermes
9. parse stdout/stderr into Paperclip execution results
10. retry once without `--resume` when the prior session is stale

## Why planning is split from execution

`createHermesExecutionPlan()` exists so the adapter can be debugged without needing to spawn Hermes.

It is responsible for deriving:

- command
- model/provider
- cwd
- prompt
- CLI args
- resume session
- env
- timeout/grace limits

Tests can validate this plan directly and isolate bugs earlier than black-box process tests.

## Session design

Hermes only requires a session ID to resume, but the adapter stores additional metadata in `sessionParams`:

- `sessionId`
- `cwd`
- `workspaceId`
- `repoUrl`
- `repoRef`

This mirrors the stronger behavior in other Paperclip adapters and prevents invalid cross-workspace session reuse.

## Prompt design

The default prompt intentionally treats Paperclip governance as first-class, not as an obstacle.

It explicitly supports:

- assigned task execution
- comment wake handling
- approval wake handling
- autonomous hiring through `/agent-hires`
- approval comments / revision / resubmit loop
- linked issues and approval status context

## Skills design

`syncHermesSkills()` copies bundled Paperclip skills into the user's Hermes home so they are available to the agent in the same way user-managed Hermes skills are.

Paperclip-managed skills are separate from user-created skills:

- bundled adapter skills = controlled by the adapter package
- existing Hermes skills = controlled by the user / Hermes ecosystem

## Diagnostics design

`testEnvironment()` does not just check "is the binary present?"

It also checks:

- Python presence
- Hermes CLI version
- Hermes home resolution
- model detection
- provider/model consistency
- provider credentials across config env, `.hermes/.env`, and common auth hints

## Transcript design

The UI parser converts Hermes stdout into structured transcript entries wherever possible:

- assistant text
- thinking lines
- tool call/result pairs
- stderr/system messages

This is the bridge that lets Paperclip render Hermes runs like the mature adapters instead of dumping raw logs.
