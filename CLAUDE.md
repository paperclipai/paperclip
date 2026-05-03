# CLAUDE.md — WBIT Cortex

This file is auto-loaded by Claude Code (and other Claude-Code-compatible agents) when working in this repo. It captures the inviolable rules; the living plan and current intent live in `internal-docs/cortex-orchestrator-plan.md`.

## What this repo is

**Cortex** is the orchestration / brain layer of the **WBIT ecosystem**. It is a hard fork of `github.com/paperclipai/paperclip` (forked 2026-04-27), maintained at `github.com/Cov12/cortex`.

Sibling apps (built in parallel, varying maturity, none can be assumed stable):
- **AgencyOS** — chat / smart communication layer (paperclip has no built-in chat)
- **WorkPipe** — CRM
- **WBIT-Drive** — Google-Drive-style shared file storage

Cortex receives requests from siblings, decides how to handle them, and dispatches agents. It is *not* a chat surface, *not* a CRM, *not* a file store.

Stack: TypeScript, pnpm workspaces, services in `server/src/services/`.

## Required reading before non-trivial work

1. **`internal-docs/cortex-orchestrator-plan.md`** — the living PRD + decision log. Open questions in §8, decisions in §9. Update it when something material changes; don't silently drift from it.
2. **`internal-docs/cortex-branch-strategy.md`** — the formal branch model + workflow recipes.
3. **`internal-docs/cortex-bayesian-engine-spec.md`** — Bayesian Decision Engine architecture (treated as a *future phase*, not the current foundation; Python pseudocode needs TS translation when picked up).

## Branch discipline (HARD RULE)

```
master → upstream-sync → integration → wbit-cortex-prod
```

- **All custom WBIT code lands on `integration`.** This includes `internal-docs/` edits, `.gitignore` tweaks, configuration, code, everything.
- **`wbit-cortex-prod` is promotion-only:** fast-forward merges from `integration`, plus the documented hotfix back-port pattern. Never commit directly.
- **`master` and `upstream-sync` are paperclip-tracking branches:** pull-only from upstream, no custom code.
- If you find uncommitted custom changes sitting on `wbit-cortex-prod`, flag it and offer to move them to `integration`.

## Working on this codebase

- **Default to extending paperclip code, not gutting it.** Inherited services in `server/src/services/` are kept for now; deprecation comes later when we know what's truly unused. Premature deletion makes upstream merges harder.
- **WBIT-specific behavior** should usually be a thin layer over an existing paperclip service rather than a parallel implementation, to keep upstream-sync merges clean.
- **Multi-tenant from day one.** All schemas, configs, and routing must be `org_id`-scoped. Paperclip's `companies` / `projects` / `agents` already model this — extend, don't replace.
- **Sibling integration uses plugins.** Decided 2026-05-03 (see plan doc §6, §9): each sibling stays an independent deployable service, but installs a thin `paperclip-plugin-wbit-{sibling}` bridge inside Cortex. Don't propose direct sibling-to-Cortex HTTP integrations without a bridge plugin in front.

## When in doubt

- Read the plan doc's open-questions section (§8) before assuming a topic is settled.
- For repo-state questions (what's tracked, what branch, what changed): use `git`, not memory.
- For workflow questions (how to sync upstream, how to promote, how to hotfix): see `internal-docs/cortex-branch-strategy.md`.
