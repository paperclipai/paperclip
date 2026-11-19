# Shared skill homes for Claude (ACPX) and OpenCode

Status: approved and implemented (2026-11-18). Extends
`doc/plans/2026-11-18-shared-codex-home-caches.md` (implemented for native Codex).

## Problem

Native Codex sessions now read their skills from one sealed skill home per skill
set. ACPX Claude and OpenCode still copy every assigned skill per launch:

- ACPX Claude/Grok/Kimi copy into `<acpx session>/claude-home/skills` before each launch
  (`acpx/runtime-host.ts`). Measured on the WSL instance: 38 sessions, 3.5 GB of
  skill copies (after the abandoned-staging cleanup already in PR #22152).
- OpenCode copies into a new isolated `HOME/.claude/skills` for every launch
  (`opencode/opencode-server-driver.ts`). No OpenCode sessions on the measured instance.

## What the user decided

- Share skills for Claude and OpenCode too, without links.
- Claude may show assigned skills with a plugin prefix (`paperclip:<skill>`): Claude
  namespaces every plugin skill and has no setting to turn that off (its plugin
  schema reserves `:` for plugin namespacing). Accepted for now.
- One pull request, no stacks.

## Spike results (2026-11-18)

- Claude Agent SDK 0.3.286, `settingSources: ["user"]` (the isolated ACPX mode), empty
  `CLAUDE_CONFIG_DIR/skills`, option `plugins: [{ type: "local", path }]` pointing at a
  read-only folder with `.claude-plugin/plugin.json` and `skills/alpha/SKILL.md`: the
  init message lists `paperclip:alpha` as a skill and a slash command.
  `additionalDirectories` with `.claude/skills` is not loaded in this mode.
- Paperclip's patched `claude-agent-acp` spreads `_meta.claudeCode.options` into the SDK
  options, so ACPX can pass `plugins` per session.
- OpenCode 1.18.34 documents `skills.paths` in its config for skills in non-default
  locations (absolute paths allowed).
- Not run: a real Claude or OpenCode turn (no Claude login in the spike).

## Design

### One store layout for all providers

Keep `runtime/paperclip-runner/skill-homes/<digest>/.agents/skills/<name>/` and add
`.agents/.claude-plugin/plugin.json` (`{"name":"paperclip","version":"<layout>",
"description":"Skills assigned by Paperclip"}`) to every newly published home:

- Codex: `HOME = <home>`; it reads `$HOME/.agents/skills` and ignores `.claude-plugin`.
- Claude (ACPX): plugin folder `<home>/.agents`; Claude reads `skills/` under it.
- OpenCode: `skills.paths = ["<home>/.agents/skills"]`.

The layout version changes (`paperclip.codex-skill-home.v2`), so the digest of every
skill set changes once and existing v1 homes age out through the existing sweep.
The manifest and stat record cover `plugin.json`. Rename the module to a
provider-neutral name only if it stays a pure rename.

### ACPX Claude

- When the ACPX agent is `claude`, the home is isolated and the runner host is Mac or
  Linux with a store root, publish/reuse the skill home instead of copying into
  `claude-home/skills`, and pass `_meta.claudeCode.options.plugins =
  [{ type: "local", path: "<home>/.agents" }]` on the ACPX `session/new` (and on
  resume/load, so a resumed session keeps its skills).
- Write the session reference marker into `claude-home/paperclip-skill-home.json`;
  the skill-home sweep also reads markers under `runtime/paperclip-runner/acpx/acpx/*/claude-home`.
- Grant the sandbox read access to `<home>/.agents` (the ACPX read roots), and keep
  `claude-home/skills` readable as today.
- Grok and Kimi keep copying until their skill discovery is checked.
- Windows: the skill home itself works on Windows for Claude (no `HOME` trick), but
  sealing and the tests need Unix permissions, so Windows keeps copying in this rollout.

### OpenCode

- With a store root on Mac or Linux, publish/reuse the skill home and add
  `skills.paths` to the generated `opencode.json` instead of copying into the
  per-launch `HOME/.claude/skills`. Admit the path read-only. Write the marker into
  OpenCode's stable session state, not into the per-launch `HOME`.

## Verification

- Red/green: two ACPX Claude launches with the same skills create one skill home and
  no `claude-home/skills` copy; the `session/new` request carries the plugin option.
- Red/green: an OpenCode launch with a store root writes `skills.paths` and copies no
  skills into its `HOME`.
- Sweep: a home referenced only by an ACPX marker is kept; removing that marker frees it.
- Real turns (needs the user's OK to copy the Claude login into a temporary WSL
  config): Claude invokes `paperclip:alpha` and reads `scripts/run.sh`; OpenCode
  loads a skill from `skills.paths`. Nothing under the skill home changes.
- Measure disk and launch time before/after for ACPX Claude on WSL.

## Left to the builder

Exact injection point of the ACPX `_meta` (the ACPX adapter's `session/new`/load
request), where OpenCode's marker lives, and helper names.
