# Antigravity CLI adapter (`agy_local`)

Runs the installed Antigravity CLI (`agy`) directly as a local agent harness.
Package: `packages/adapters/agy-local`. The code and its tests are the source of
truth; this note records the behavior that is not obvious from them.

## How it differs from the built-in Antigravity route

The Antigravity route through Paperclip Runner and ACPX is gated: its
qualification is pending, it needs a candidate-admission grant, and its
distribution pins do not cover Windows. `agy_local` does not use any of that. It
spawns `agy` as a child process, the same way `claude_local` spawns `claude`.
It is local-only and is not in `REMOTE_MANAGED_ADAPTERS`.

## Run shape

```
agy -p <prompt> --output-format stream-json
    [--model <id>] [--effort <level>] [--mode <mode>]
    [--dangerously-skip-permissions] [--sandbox]
    [--conversation <id>] [extraArgs...]
```

- Print mode already defaults to always-proceed permissions.
- Prompt = optional instructions file (fresh runs only) + the heartbeat prompt.
- Paperclip env (`PAPERCLIP_*`, run-scoped API key) is injected into the process.

## Working directory

The run uses the project workspace when there is one. `adapterConfig.cwd` is only
a fallback (and the environment test directory). The board UI labels that field
"deprecated" for every local adapter, not just this one.

## Sessions

`agy` prints a conversation id in its `init` event. The adapter saves
`{ sessionId, cwd }` and resumes with `--conversation` only when the saved `cwd`
matches the current one. Resuming an unknown conversation prints
`warning: conversation "<id>" not found`, exits 0, and starts a new one; the
adapter detects that and retries as a fresh run once.

## Output and usage

`stream-json` emits `init`, `step_update` (`user_input`, `agent_response`,
`tool`, `system_message`) and a final `result` with token usage. Usage maps to
Paperclip usage (thinking tokens count as output). Billing is reported as
`subscription` with cost 0 and provider `antigravity`.

## Environment test

Checks the working directory, that `agy` resolves, `agy --version`, and a hello
probe (`agy -p "Respond with hello."`, 90 s default; override with
`helloProbeTimeoutSec`). Check codes are prefixed `agy_`. A signed-out `agy`
reports `agy_hello_probe_auth_required` as a warning; fix it by running `agy`
once in a terminal and signing in.

## Not supported

- Skill sync: `listSkills` and `syncSkills` return an unsupported snapshot.
- Remote or managed-cloud environments.

## Models

Defaults to `gemini-3.8-flash-medium`. The list in `src/index.ts` comes from
`agy --help` on the installed build; update it when agy adds or drops models.
