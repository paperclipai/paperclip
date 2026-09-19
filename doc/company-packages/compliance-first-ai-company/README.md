# Compliance-First AI Software Company

This company is designed to run `djcowork2.0` as a compliance-first AI
software organization.

It uses Paperclip for:

- goals
- org structure
- issue hierarchy
- approvals
- heartbeats
- budgets
- workspace routing

and GitHub for:

- branches
- commits
- pull requests
- checks
- merge protection

## Operating Model

The company runs in two phases:

1. compliance first
2. throughput optimization second

No agent writes code unless the lane is allowed, the task is isolated, and the
review path is clear.

## Org Chart

| Role | Reports To | Purpose |
|---|---|---|
| CEO | board | strategy, priorities, escalation |
| CTO | CEO | technical direction and cross-lane control |
| Audit Lead | CTO | compliance gate and lane audit |
| Delivery Lead | CTO | turn findings into fix tasks |
| Workspace Director | CTO | isolated workspaces and branch hygiene |
| Validation Director | CTO | batch validation and baselines |
| Merge Director | CTO | PR readiness and merge control |
| Architecture Lead | Audit Lead | v2 / phase gate enforcement |
| GitNexus Lead | Audit Lead | symbol impact analysis and dependency blast radius |
| Desktop Compliance Lead | Audit Lead | desktop-specific hard floors |
| Audio RT Lead | Audit Lead | realtime safety checks |
| Dependency/Security Lead | Audit Lead | dependency and security governance |
| Docs/Blind-Spots Lead | Audit Lead | ambiguous cases and doc coverage |
| Core Lead | Delivery Lead | core crate delivery |
| Desktop Lead | Delivery Lead | desktop lane delivery |
| DJ Lead | Delivery Lead | DJ lane delivery |
| Integration Lead | Delivery Lead | adapters and cross-module work |
| Core Engineer 1 | Core Lead | code fix execution |
| Core Engineer 2 | Core Lead | code fix execution |
| Desktop Engineer 1 | Desktop Lead | code fix execution |
| Desktop Engineer 2 | Desktop Lead | code fix execution |
| DJ Engineer 1 | DJ Lead | code fix execution |
| DJ Engineer 2 | DJ Lead | code fix execution |
| Integration Engineer 1 | Integration Lead | glue code and lane stitching |
| Integration Engineer 2 | Integration Lead | glue code and lane stitching |
| Workspace Operator | Workspace Director | worktree / checkout / environment setup |
| Runner Coordinator | Workspace Director | runner routing and queue hygiene |
| Test Engineer | Validation Director | unified validation batches |
| Build Verifier | Validation Director | final build and merge gating |
| Performance Baseline Engineer | Validation Director | perf evidence and regression watch |

## Workflow

1. `CEO` receives the company goal and turns it into lane priorities.
2. `CTO` approves the technical order of attack.
3. `Audit Lead` checks the lane against policy and records blockers.
4. `Delivery Lead` creates single-concept fix work.
5. `Workspace Director` assigns an isolated workspace and branch.
6. `Engineer` checks out the issue, writes the fix, and opens a draft PR.
7. `Validation Director` batches tests and performance work.
8. `Merge Director` checks PR readiness and merge safety.
9. `CEO` reports status upward and keeps the queue moving.

## Rules

- one issue, one owner, one workspace, one PR
- no concurrent writes in the same crate area
- no local cargo fan-out
- no silent failure paths
- no test shard explosion
- no merge without evidence
- tasks, issues, and routines should use Chinese by default
- agent names, adapter types, repo paths, and code identifiers may stay in English
- `codex_local` primary and recovery/cheap model profiles are both pinned to `gpt-5.5` + `xhigh`

## Getting Started

Import this package into Paperclip and then assign adapters and budgets in the
UI.

Recommended import path:

`paperclipai company import ./doc/company-packages/compliance-first-ai-company`

## Variants

This package ships two `.paperclip.*.yaml` files. Pick the one that matches
where the Paperclip runtime is hosted, then `cp` it to `.paperclip.yaml`
before import.

| File | When to use |
|------|-------------|
| `.paperclip.yaml` | Paperclip runs on the Windows host, djcowork2.0 lives at `D:\code\djcowork2.0`. Default for first-time setup. |
| `.paperclip.wsl2.yaml` | Paperclip runs inside WSL2 Ubuntu, djcowork2.0 lives at `$HOME/work/djcowork2.0` on the ext4 filesystem. Recommended steady-state — see `doc/plans/2026-05-14-wsl2-cross-compile-migration.md` for full migration steps and why this fixes the Windows stability issues. |

Switching is `cp .paperclip.wsl2.yaml .paperclip.yaml && paperclipai company
import .` (re-import re-applies the new cwd to every agent).

## Linked execution plans

- `doc/plans/2026-05-14-wsl2-cross-compile-migration.md` — moving the runtime
  to WSL2 and cross-compiling djcowork2.0 to Windows from Linux
- `doc/plans/2026-05-14-djcowork2-github-hardening.md` — staged PR bundle for
  the djcowork2.0 repository (CODEOWNERS, cargo-audit/vet, merge queue,
  Repository Ruleset, GitHub App)
- `doc/plans/2026-05-14-plugin-paperclip-github-design.md` — design for the
  typed GitHub agent plugin that replaces ad-hoc `gh` shell calls

## References

- Agent Companies spec: https://agentcompanies.io/specification
- Paperclip: https://github.com/paperclipai/paperclip
