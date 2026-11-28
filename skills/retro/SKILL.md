---
name: retro
description: >
  Conduct a coding session retrospective to improve future agent runs.
---

# Retro Skill

Conduct a retrospective on a coding session to improve future agent runs. The output is a prioritized list of environment and process improvements, not a rewrite of what happened.

## When to Use

- The user asks for a retrospective on a session
- You want to surface navigation, check, standards, or tool-economy improvements

**When NOT to use:** Debugging a specific bug or reviewing a specific diff.

## Prerequisites

- Access to session logs or the current session context

## How to Run

Invoke the retro skill and name a session (default: the current one). The agent reads session sources, lists improvement candidates by category, and presents them in order of severity.

## Quick Reference

- Categories: Navigation, Automated checks, Coding standards, Global AGENTS.md, Tool economy, No-ops, Information access

## Procedure

1. Read the primary sources for the session the user specifies; default to the current session.
2. List improvement candidates across all seven categories.
3. Present candidates to the user in order of severity.

## Pitfalls

- Confusing a retrospective with a code review of the session's diff
- Rewriting what happened instead of proposing improvements
- Skipping categories so whole classes of improvements are missed

## Verification

- Candidates cover all seven improvement categories
- Candidates are presented in order of severity
