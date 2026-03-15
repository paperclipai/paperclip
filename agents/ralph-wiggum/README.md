# Ralph Wiggum Setup

This directory contains the portable instructions file for the `Ralph Wiggum` agent.

There are two related setup modes:

- **Local `claude_local` setup:** point `adapterConfig.instructionsFilePath` at the absolute path to `agents/ralph-wiggum/AGENTS.md`
- **Portable import/export setup:** keep this file in `agents/ralph-wiggum/AGENTS.md`; Paperclip portability packages the markdown itself and strips machine-local `instructionsFilePath` values on import

## Intended Agent Shape

- **Name:** `Ralph Wiggum`
- **Title:** `Chief Strategist`
- **Reports to:** `CEO`
- **Adapter type:** `claude_local`
- **Role:** `general` unless a dedicated strategy role is added later
- **Capabilities:** `Refines quarterly roadmaps, cross-functional plans, executive sequencing, dependencies, and readiness reviews`

## Instructions Path

For a local `claude_local` agent, point the agent's instructions file at the absolute path to this file, for example:

```text
/absolute/path/to/paperclip/agents/ralph-wiggum/AGENTS.md
```

This should populate `adapterConfig.instructionsFilePath`.

## Working Directory

Set `adapterConfig.cwd` to the repo root or worktree Ralph is expected to review, for example:

```text
/absolute/path/to/paperclip
```

Without an explicit `cwd` or attached workspace, `claude_local` falls back to the Paperclip server process directory, which is too brittle for roadmap or repository-aware reviews.

## Portability Note

For company import/export, this file should remain at `agents/ralph-wiggum/AGENTS.md` with `kind: agent` frontmatter. Portable imports use the markdown body as the imported prompt content and intentionally remove machine-local `instructionsFilePath` values.

## Recommended Runtime Defaults

- Wake on assignment: enabled
- Wake on on-demand: enabled
- Timer-driven wakeups: low frequency or disabled
- Budget: sized for multi-pass planning work, not continuous execution

## Assignment Guidance

Good assignments:

- quarterly roadmap refinement
- cross-functional launch plan review
- broad initiative hardening before delegation

Bad assignments:

- coding work
- bug fixing
- implementation details for a small feature
- tests or migrations

## Example Task Prompt

```md
Review the attached quarterly roadmap and improve it in three iterations.

Focus on:
- strategic clarity
- cross-functional dependencies
- sequencing
- executive ownership
- decision gates
- execution readiness

Do not write code. Return a revised roadmap, remaining risks, and a readiness verdict.
```
