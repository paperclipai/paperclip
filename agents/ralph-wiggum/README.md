# Ralph Wiggum Setup

This directory contains the portable instructions file for the `Ralph Wiggum` agent.

## Intended Agent Shape

- **Name:** `Ralph Wiggum`
- **Title:** `Chief Strategist`
- **Reports to:** `CEO`
- **Adapter type:** `claude_local`
- **Role:** `general` unless a dedicated strategy role is added later
- **Capabilities:** `Refines quarterly roadmaps, cross-functional plans, executive sequencing, dependencies, and readiness reviews`

## Instructions Path

Point the agent's instructions file at the absolute path to this file, for example:

```text
/absolute/path/to/paperclip/agents/ralph-wiggum/AGENTS.md
```

For `claude_local`, this should populate `adapterConfig.instructionsFilePath`.

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
