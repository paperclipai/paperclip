# @paperclipai/adapter-devin-local

## 0.0.1

### Minor Changes

- Initial release of the first-party `devin_local` adapter.
- Executes runs via CLI print-mode (`devin -p`) with `--export` ATIF
  transcript capture, `--prompt-file` prompt delivery, and session resume via
  `-r` when the working directory matches.
- Parses print-mode stdout and the exported ATIF transcript for the session
  id and token metrics.
- Model discovery from `devin models list --format json` with an empty-list
  fallback (never a stale hardcoded list); host default model detection via
  `detectModel`. Each base model exposes its family's supported
  reasoning-effort tiers (`efforts`) so the board offers only the tiers the
  selected model has; an explicit `thinkingEffort` outside the family's tiers
  is a hard error.
- Usage and cost reporting from the ATIF transcript: per-step pricing at
  each step's own model rates, cached tokens never billed at the full input
  rate, `costUsd: null` with a coverage marker on partial step coverage, and
  a per-model breakdown in `resultJson.devinModelBreakdown`.
- Instructions: Devin auto-loads `<cwd>/AGENTS.md`; any other configured
  entry file (e.g. a Paperclip-managed instructions bundle) is delivered in
  the prompt, with a directive naming its directory as authoritative for
  sibling files (`HEARTBEAT.md`/`SOUL.md`/`TOOLS.md`).
- Prompt parity with the other built-in local adapters: Agent Chat
  conversation mode uses the conversation prompt template and the server's
  task-context markdown, fresh sessions receive the initial communication
  guidance, and wake context travels only in the prompt (no
  `PAPERCLIP_WAKE_PAYLOAD_JSON` environment copy).
- Skills: desired Paperclip skills are symlinked into `<cwd>/.devin/skills/`
  only while a run needs them. Concurrent runs sharing a cwd
  reference-count the staged links through lease files in the OS temp dir,
  leftovers from crashed runs or earlier builds are pruned by the next run
  in that cwd, and the operator's global `~/.config/devin/skills` home is
  never read or written. `listSkills` / `syncSkills` report a
  configured-for-run view and update only the stored desired set.
- Permission posture mirrors the CLI: `permissionMode` is forwarded
  unchanged (the CLI validates and safely degrades rollout-gated modes), the
  flag is omitted when unset so the CLI default applies, and `sandbox: true`
  always emits `--sandbox` with the coercion to autonomous logged.
- UI config fields, CLI event formatter, and environment test probe.
