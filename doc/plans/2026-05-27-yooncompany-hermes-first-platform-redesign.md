# YoonCompany Hermes-First Platform Redesign Plan - 2026-05-27

## Status

- Status: PM direction accepted in chat; implementation still requires step-level review.
- Risk level: L1 local planning document.
- Dangerous actions executed: none.
- DB writes executed: none.
- Agent config changes executed: none.
- Commit/push/PR/merge executed: none.

This document replaces the previous working assumption that Paperclip should be the main control plane and Hermes should remain only a research/log/sub-worker. That assumption does not fit the PM's stated product goal.

## Executive Decision

The platform should be redesigned around this operating model:

- Hermes is the core orchestrator and agent runtime.
- Paperclip is the operating console, approval ledger, budget/audit layer, and visual management surface.
- Codex is a development specialist worker that can be assigned implementation work through Paperclip and, later, through Hermes-orchestrated handoff paths.

This does not mean throwing away the Paperclip work. The Korean UI work, YoonCompany assistant panel, backlog draft behavior, cost labeling, skill state clarity, and run/comment safety fixes are still useful. The correction is architectural: Paperclip should not suppress Hermes's native capabilities. It should expose, govern, and audit them.

## Why The Previous Direction Was Wrong

The previous handoff says:

- Paperclip is the control plane and screen manager.
- Codex is the main development worker.
- Hermes is the research/log/sub-worker.

That produced a safe boot state, but it also locked the strongest engine into a low-power role. The current Hermes Paperclip agent is named `Hermes Research Worker`, reports to Codex, has a prompt that forbids most operational actions, and is configured with only:

```text
terminal,memory,session_search,skills,web
```

This omits the features that make Hermes v0.14 valuable as an orchestrator:

- profiles
- Kanban multi-agent board
- dispatcher
- delegation via `delegate_task`
- file toolset
- browser toolset
- MCP
- persistent sessions
- gateway/dashboard surfaces

The result is a mismatched product: Hermes is installed, but Paperclip currently uses it as a narrow research commenter.

## Verified Local Facts

### Paperclip repository state

Workspace:

```text
C:\yooncompany\external\paperclip
```

Verified commands:

```powershell
git status --short --branch
git rev-parse --short HEAD
git rev-list --left-right --count HEAD...upstream/master
git rev-list --left-right --count HEAD...fork/master
corepack pnpm list hermes-paperclip-adapter -r --depth 0
corepack pnpm view hermes-paperclip-adapter version versions description --json
```

Results:

- Current branch: `codex/yooncompany-fork-master-integration`.
- Current commit: `9be28c64f`.
- Worktree status: clean at time of inspection.
- Fork relation: `HEAD...fork/master = 0 0`.
- Upstream relation: `HEAD...upstream/master = 31 0`; the fork has local YoonCompany/Paperclip integration commits and no missing upstream commits at the time checked.
- Installed Hermes Paperclip adapter at first inspection: `hermes-paperclip-adapter 0.2.0`.
- Applied in the current follow-up slice: `hermes-paperclip-adapter ^0.3.0` in both `server/package.json` and `ui/package.json`.
- Latest npm adapter version verified during this work: `0.3.0`.

Interpretation:

- The Paperclip fork itself is not behind upstream `master` at the time checked.
- The Hermes adapter dependency was behind npm latest; the diff review was written and the dependency was upgraded to `0.3.0` in a separate L2 package slice.

### Hermes repository and runtime state

Workspace:

```text
C:\yooncompany\external\hermes-agent
```

Verified commands:

```powershell
git status --short --branch
git rev-parse --short HEAD
C:\yooncompany\bin\hermes.exe --version
C:\yooncompany\bin\hermes.exe --help
C:\yooncompany\bin\hermes.exe tools list
```

Results:

- Hermes repo is at `cea87d9`.
- Hermes local runtime reports `Hermes Agent v0.14.0 (2026.5.16)`.
- Hermes has commands for `chat`, `gateway`, `cron`, `kanban`, `skills`, `memory`, `tools`, `mcp`, `profile`, `dashboard`, `logs`, and more.
- Current global Hermes tool availability includes:
  - enabled: `browser`
  - enabled: `terminal`
  - enabled: `file`
  - enabled: `code_execution`
  - enabled: `skills`
  - enabled: `memory`
  - enabled: `session_search`
  - enabled: `delegation`
  - enabled: `cronjob`
  - disabled: `moa`

Interpretation:

- Hermes itself is not merely a research helper.
- The local Hermes runtime already has the capabilities needed to act as the orchestrator.
- The Paperclip agent configuration is what narrows Hermes down.

### Current Paperclip agent configuration

Verified through:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/companies/a01eddd0-d750-43ea-8858-d1cb087c4de2/agents"
```

Current agents:

- `Codex Lead Engineer`
  - `adapterType`: `codex_local`
  - title: `6002 Lead Development Worker`
  - `dangerouslyBypassApprovalsAndSandbox`: false
  - heartbeat disabled

- `Hermes Research Worker`
  - `adapterType`: `hermes_local`
  - title: `Research, memory, and report worker - repo write prohibited`
  - reports to Codex
  - heartbeat disabled
  - `toolsets`: `terminal,memory,session_search,skills,web`
  - `persistSession`: false
  - `worktreeMode`: false
  - `checkpoints`: false
  - `extraArgs`: `--yolo --max-turns 8`
  - permissions include `canAssignTasks=true` and `canCreateAgents=true`
  - metadata says `repoWrite=prohibited`

Interpretation:

- Hermes is configured as a subordinate research worker, not an orchestrator.
- `--yolo` plus a restrictive prompt is an inconsistent safety posture: it bypasses Hermes-side approval prompts while relying on natural-language prohibitions.
- `canCreateAgents=true` conflicts with a "research-only" role and should be re-evaluated before any live automation.

## Public Research Findings

### Official Paperclip positioning

Paperclip's adapter documentation describes adapters as the bridge between Paperclip's orchestration layer and agent runtimes:

- Source: https://paperclip.inc/docs/adapters/overview

Paperclip's approval documentation positions approvals as the human board operator control point:

- Source: https://paperclip.inc/docs/guides/board-operator/approvals

Interpretation:

- Paperclip is strong as governance, tasking, heartbeat, budget, audit, approval, and multi-runtime adapter surface.
- Paperclip should not replace Hermes's native orchestrator when Hermes is the stronger runtime for profile/kanban/delegation work.

### Official Hermes positioning

Hermes features overview says Hermes has toolsets for web, terminal, file editing, memory, delegation, and more:

- Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/

Hermes Kanban is a durable multi-agent board shared across Hermes profiles:

- Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban

Hermes delegation uses `delegate_task` to spawn child AIAgent instances with isolated context, restricted toolsets, and their own terminal sessions:

- Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/

Hermes profiles provide separate Hermes home directories with separate config, env, SOUL, memory, sessions, skills, cron jobs, and state DB:

- Source: https://hermes-agent.nousresearch.com/docs/user-guide/profiles/

Interpretation:

- Hermes should be the orchestration core for profile-driven work.
- Hermes Kanban and profiles are not cosmetic. They are the native multi-agent mechanism.
- `delegate_task` is useful for short synchronous parallel reasoning, while Kanban is better for durable multi-role work.

### Public integration examples

Relevant public repositories found:

- `NousResearch/hermes-paperclip-adapter`: official adapter for running Hermes as a managed Paperclip employee.
  - https://github.com/NousResearch/hermes-paperclip-adapter
- `runtimenoteslabs/gladiator`: Paperclip + Hermes multi-agent demo with companies, agents, evidence DB, and dashboard.
  - https://github.com/runtimenoteslabs/gladiator
- `iyurinok/paperclip-hermes-profile-adapter`: profile-aware Paperclip adapter scaffold; useful for HERMES_HOME/profile isolation thinking.
  - https://github.com/iyurinok/paperclip-hermes-profile-adapter
- `dandacompany/paperclip-hermes-codex-on-hostinger`: packaging/deployment example exposing Paperclip Web, Hermes Dashboard, and Hermes TUI separately.
  - https://github.com/dandacompany/paperclip-hermes-codex-on-hostinger
- `Vivere-Vitalis-LLC/Ollama-Cloud-Hermes-Agent-Paperclip`: provider/model routing example through Paperclip -> Hermes.
  - https://github.com/Vivere-Vitalis-LLC/Ollama-Cloud-Hermes-Agent-Paperclip

Interpretation:

- Public work exists, but most examples still treat Paperclip as the top orchestrator and Hermes as a worker runtime.
- The closest pattern to YoonCompany's goal is not a single repo to copy. It is a combined design:
  - Hermes-native profiles/Kanban/delegation for real multi-agent work.
  - Paperclip for governance, approvals, audit, budget, issue tracking, and UI.
  - Profile isolation ideas from profile-aware adapters.
  - Evidence/log ideas from `gladiator`.

## Corrected Target Architecture

### Layer 1: Hermes Core Orchestrator

Hermes owns:

- orchestrator profile
- specialist profiles
- Hermes Kanban boards
- durable handoffs between Hermes profiles
- `delegate_task` for short synchronous parallel subtasks
- memory and skills
- gateway/dashboard/log/session surfaces
- MCP/toolset expansion where approved

Hermes should not be reduced to a "research comment worker."

### Layer 2: Paperclip Operating Console

Paperclip owns:

- company view
- approval gates
- issue records and operator decisions
- budget/cost visibility
- agent roster/status
- run logs
- human-readable audit trail
- external worker integration, including Codex
- safe backlog drafts from UI

Paperclip should show Hermes orchestration state. It does not need to duplicate all Hermes runtime internals.

### Layer 3: Codex Development Worker

Codex owns:

- repo code edits
- tests/typecheck/browser verification
- git diff preparation
- PR preparation when approved
- implementation risk reports

Codex should not be described as Hermes's binary executor. It is a development specialist that Hermes or Paperclip can route work to.

### Layer 4: Approval and Safety Boundary

L3/L4 actions remain gated:

- agent config changes
- Hermes profile creation or persistent profile changes
- heartbeat/cron/gateway changes
- DB writes/migrations
- credential/auth changes
- git push/PR/merge
- deployment
- external publish/send/payment

The current risk policy remains valid, but the role text must be updated.

## Work Routing Model

### Durable orchestration work

Use Hermes Kanban when:

- work needs multiple specialist roles
- work needs to survive restarts
- handoffs matter
- a different agent/profile may continue later
- PM wants visibility into a long chain

Paperclip should show summary status and links for these Hermes Kanban tasks.

### Short parallel subtasks

Use Hermes `delegate_task` when:

- the parent Hermes run needs a quick reasoning answer before continuing
- the task is bounded
- no human approval is needed mid-task
- result returns to the parent context

Do not use `delegate_task` as a durable job queue.

### Development implementation

Use Codex when:

- repo files must be changed
- tests must be run
- browser verification is needed
- git/PR work is needed

The safe first integration path is:

```text
Hermes Orchestrator
-> creates/updates Paperclip issue assigned to Codex
-> Paperclip approval/status governs execution
-> Codex runs implementation and reports evidence
-> Paperclip stores result
-> Hermes may read the result and continue orchestration
```

Direct Hermes -> Codex process spawning can be researched later, but the first safe path should use Paperclip as the audit/gate surface.

## Dashboard Redesign Direction

The Paperclip UI should shift from "Codex/Hermes quick actions" to "Hermes orchestration console."

Read-only first surfaces:

1. Hermes runtime status
   - version
   - command path
   - adapter version
   - enabled toolsets
   - active profile / HERMES_HOME
   - gateway/dashboard availability

2. Hermes role warning
   - current Paperclip Hermes agent is research-locked
   - missing orchestration toolsets
   - `persistSession=false`
   - `--yolo` present
   - `canCreateAgents=true` while role says no persistent changes

3. Hermes Kanban preview
   - board list
   - task counts by status
   - running/blocked/done
   - active assignees/profiles
   - deep links or commands to inspect in Hermes dashboard/CLI

4. Profile roster
   - profile name
   - description
   - HERMES_HOME path
   - memory/skills/session status
   - allowed Paperclip mapping

5. Cross-system work map
   - Paperclip issue id
   - Hermes board/task id
   - agent/profile
   - current status
   - last evidence
   - approval gate state

Write/mutation surfaces must come later and require approval.

## What To Preserve

Keep:

- YoonCompany Koreanization work.
- Backlog draft behavior.
- Global question panel, but rename/reshape it as the operator intake for Hermes-first routing.
- Cost subscription/API separation.
- Skills state clarity.
- run-authored comment wakeup safety fix.
- Codex 6002 task template hardening.
- Paperclip issue/approval APIs as governance.

Do not discard this work. It becomes the console shell around Hermes.

## What To Stop Doing

Stop treating these as the next priority until the architecture is corrected:

- residual body Koreanization as the main track
- global question panel v2 as a Codex-first entry point
- screen context auto-attach as the next main feature

Those are useful UI improvements, but they are second-order. The first-order problem is that Hermes's role and capabilities are mis-modeled.

## Immediate Improvement Plan

### Phase 0: Document and PM approval

Goal:

- accept or revise this Hermes-first architecture.

Tasks:

- Create this document.
- Do not change agent configs yet.
- Do not upgrade dependencies yet.
- Do not create/delete agents yet.

Verification:

- document exists
- git diff reviewed
- no DB/config mutation performed

### Phase 1: Adapter and source baseline

Goal:

- understand the delta between `hermes-paperclip-adapter 0.2.0` and `0.3.0`.

Tasks:

- inspect package diff/changelog
- compare our local `server/src/adapters/registry.ts` Hermes wrapping logic against adapter 0.3.0 expectations
- identify whether 0.3.0 adds profile/toolset/session capabilities we should use
- produce an upgrade plan before changing package files

Risk:

- dependency update is L2 repo change and may affect runtime behavior
- plugin/package lock changes must be isolated

### Phase 2: Hermes status read-only console

Goal:

- make Paperclip honestly show that Hermes is the core runtime and what is currently enabled/disabled.

Tasks:

- add read-only Hermes runtime/status panel
- show local Hermes version
- show adapter version
- show configured Paperclip Hermes toolsets
- show global Hermes enabled toolsets
- warn when orchestration toolsets are missing

Risk:

- read-only UI/API addition is L2 repo change
- no agent config mutation

### Phase 3: Orchestrator profile design

Goal:

- design the actual Hermes orchestrator and specialist profiles.

Draft profiles:

- `yoon-orchestrator`: routes work, decomposes tasks, owns Hermes Kanban.
- `yoon-research`: market/research/doc investigation.
- `yoon-docs`: document writing and internal knowledge cleanup.
- `yoon-dev-codex-bridge`: creates Paperclip issues for Codex implementation, not direct code execution.
- `yoon-business`: business division planning.
- `yoon-media`: YouTube/content division planning.
- `yoon-academy`: Academy/Tinker operation planning.
- `yoon-tincolive`: TincoLive product/development planning.

Risk:

- creating profiles or changing persistent Hermes config is L3.
- must be approval-gated before execution.

### Phase 4: Paperclip-Hermes mapping

Goal:

- define how Paperclip issues map to Hermes Kanban tasks.

Rules:

- Paperclip issue is the governance/audit object.
- Hermes Kanban task is the internal multi-agent work object.
- Every cross-system mutation must leave both ids in evidence:
  - `paperclip_issue_id`
  - `hermes_board`
  - `hermes_task_id`
  - `agent_or_profile`
  - `approval_id` or `approval_id: none`

Risk:

- mapping persistence may require schema or document storage decisions.
- start read-only/textual before DB schema changes.

### Phase 5: Controlled Hermes orchestration enablement

Goal:

- move Hermes from research worker to orchestrator safely.

Candidate config direction:

- replace or add a separate `Hermes Orchestrator` Paperclip agent.
- do not mutate the current research worker until the new role is clear.
- remove contradictory `--yolo` or justify it under an approved local-only profile.
- enable needed toolsets in steps:
  1. `file` read paths only if supported by policy
  2. `browser`
  3. `mcp`
  4. `delegation`
  5. `kanban`
- turn on `persistSession` only for approved orchestrator profile.

Risk:

- agent config, toolsets, heartbeat, persistent profile/rule changes are L3.
- no execution without Paperclip approval.

## Proposed New Next Work Order

Do not continue the old Next Improvement Plan as-is. Replace it with:

1. Review and accept/revise this Hermes-first architecture document.
2. Create a small follow-up document comparing adapter `0.2.0` vs `0.3.0`.
3. Add a read-only Hermes runtime/status console panel to Paperclip.
4. Design Hermes profiles and Paperclip mapping without enabling them.
5. Request approval for the first persistent Hermes config/profile change.
6. Only then resume UI polish: Koreanization, question panel, screen context.

## Step Progress

| Step | Status | Notes |
| --- | --- | --- |
| 1. Architecture acceptance | In progress | PM confirmed the core is Hermes-first. This document is the working baseline. |
| 2. Adapter diff | Complete | See `2026-05-27-hermes-paperclip-adapter-0-3-diff.md`; package upgrade to `0.3.0` applied after diff review. |
| 3. Read-only Hermes status console | Sixth slice complete | Global YoonCompany panel and dashboard now expose current Hermes role/toolset/session/safety mismatch, the phase 1 approval package preview, blocked dangerous actions, a no-execution issue draft action, the planned Hermes profile roster, and read-only Kanban/cross-link previews. |
| 4. Hermes profile design | Proposal complete | See `2026-05-27-yooncompany-hermes-first-steps-4-7.md`; no profile creation executed. |
| 5. Paperclip-Hermes mapping | Preview implemented | Textual cross-link format is now visible in the dashboard; no DB schema change. |
| 6. Hermes capability enablement | Approval draft complete | Actual agent/profile/config mutation remains blocked pending Paperclip approval. |
| 7. UI polish reorder | Complete | UI order now starts with Hermes runtime/profile/Kanban visibility, then Koreanization/question panel/screen context. |

## Open Questions For PM

1. Should Paperclip remain the only visible daily dashboard, or should it deep-link/embed the Hermes dashboard at `9119`?
2. Should Hermes Kanban become the main task decomposition engine while Paperclip issues remain governance records?
3. Should the existing `Hermes Research Worker` be replaced, or should a new `Hermes Orchestrator` agent be added beside it?
4. Should Codex be invoked only through Paperclip issues first, or should later work explore direct Hermes-to-Codex execution through MCP/ACP/CLI?

## Current Risk Register

| Risk | Current state | Recommendation |
| --- | --- | --- |
| Wrong role model | Confirmed | Update docs and task templates before further UI work |
| Hermes adapter outdated | Resolved in package files: 0.3.0 installed for server/ui | Actual agent config still needs approved migration because adapter 0.3.0 adds managed `--yolo` behavior |
| Hermes capabilities hidden | Confirmed: Paperclip toolsets omit `delegation`, `kanban`, `file`, `browser`, `mcp` | Add read-only status first, then approval-gated enablement |
| Prompt-only safety | Confirmed: restrictive prompt plus `--yolo` | Replace with config/toolset/permission controls |
| Agent creation permission mismatch | Confirmed: Hermes has `canCreateAgents=true` while role says no persistent changes | Approval-gated permission audit |
| Duplicate boards | Expected risk | Paperclip = governance, Hermes Kanban = work execution; always cross-link IDs |
| Rebuild temptation | Avoid | Preserve existing Paperclip improvements and refactor direction only |

## Verification Performed For This Document

Commands run:

```powershell
Get-Content C:\yooncompany\external\paperclip\doc\plans\2026-05-27-yooncompany-ai-company-console-handoff.md
git status --short --branch
git rev-parse --short HEAD
git fetch upstream master
git fetch fork master
git rev-list --left-right --count HEAD...upstream/master
git rev-list --left-right --count HEAD...fork/master
corepack pnpm list hermes-paperclip-adapter -r --depth 0
corepack pnpm view hermes-paperclip-adapter version versions description --json
C:\yooncompany\bin\hermes.exe --version
C:\yooncompany\bin\hermes.exe --help
C:\yooncompany\bin\hermes.exe tools list
Invoke-RestMethod http://127.0.0.1:3100/api/companies/a01eddd0-d750-43ea-8858-d1cb087c4de2/agents
```

External sources checked:

- https://paperclip.inc/docs/adapters/overview
- https://paperclip.inc/docs/guides/board-operator/approvals
- https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/
- https://hermes-agent.nousresearch.com/docs/user-guide/profiles/
- https://github.com/NousResearch/hermes-paperclip-adapter
- https://github.com/runtimenoteslabs/gladiator
- https://github.com/iyurinok/paperclip-hermes-profile-adapter
- https://github.com/dandacompany/paperclip-hermes-codex-on-hostinger
- https://github.com/Vivere-Vitalis-LLC/Ollama-Cloud-Hermes-Agent-Paperclip

## Bottom Line

YoonCompany should not restart from zero. It should pivot:

```text
Old: Paperclip control plane -> Codex lead -> Hermes research worker
New: Hermes orchestrator/runtime -> Paperclip operating console/governance -> Codex development worker
```

The existing Paperclip improvements become the console foundation. The next serious work is to use the issue draft action to request phase 1 approval, then execute only the exact approved profile/toolset/Kanban scope.
