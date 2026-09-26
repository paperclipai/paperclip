# Compliance-First AI Company Operating Model

## Objective

Run the company as a compliance machine first, then a throughput machine second.

Success means:

- every code lane is gated by policy before execution
- every code issue has a single owner, workspace, branch, and PR
- no local cargo pileups or overlapping write lanes
- validation is batched, not fragmented
- merge/release is controlled, auditable, and repeatable

## Operating Principle

Compliance is the product. Efficiency is the optimization target only after compliance is stable.

## Company Goal

`Maintain Phase 1 compliance for djcowork2.0, then maximize safe delivery throughput without violating AGENTS/CURRENT-PHASE/architecture standards.`

## 30-Role Org Model

### Control

- CEO
- CTO
- Audit Lead
- Delivery Lead
- Workspace Director
- Validation Director
- Merge Director

### Compliance

- Architecture Lead
- GitNexus Lead
- Desktop Compliance Lead
- Audio RT Lead
- Dependency/Security Lead
- Docs/Blind-Spots Lead

### Delivery

- Core Lead
- Desktop Lead
- DJ Lead
- Integration Lead

### Execution

- Core Engineer 1
- Core Engineer 2
- Desktop Engineer 1
- Desktop Engineer 2
- DJ Engineer 1
- DJ Engineer 2
- Integration Engineer 1
- Integration Engineer 2

### Operations / Validation

- Workspace Operator
- Runner Coordinator
- Test Engineer
- Build Verifier
- Performance Baseline Engineer

## Reporting Tree

- CEO -> board
- CTO -> CEO
- Audit Lead, Delivery Lead, Workspace Director, Validation Director, Merge Director -> CTO
- Architecture Lead, GitNexus Lead, Desktop Compliance Lead, Audio RT Lead, Dependency/Security Lead, Docs/Blind-Spots Lead -> Audit Lead
- Core Lead, Desktop Lead, DJ Lead, Integration Lead -> Delivery Lead
- Core / Desktop / DJ / Integration engineers -> their respective lead
- Workspace Operator, Runner Coordinator -> Workspace Director
- Test Engineer, Build Verifier, Performance Baseline Engineer -> Validation Director

## Workflow

1. Board sets the goal and approves strategy.
2. CEO converts the goal into lane priorities.
3. Audit Lead verifies the lane is allowed and records blockers.
4. Delivery Lead converts findings into single-concept fix issues.
5. Workspace Director assigns isolated workspaces and branch discipline.
6. Engineers checkout one task, write one concept, open one PR.
7. Validation Director batches tests and baseline captures.
8. Merge Director handles review readiness, merge gating, and cleanup.

## Resource Allocation

- local 20-core / 63 GB host: planning, auditing, lightweight coding, comment routing
- dedicated server with multiple runners: build, test, lint, baseline, release
- local cargo is reserved for one-shot debugging only
- runner capacity is the real throughput engine

## Efficiency Rules

- no shared write lane for the same crate area
- no concurrent local cargo sessions
- no code task without a parent issue and a PR target
- no PR without compliance notes and verification evidence
- no validation shard explosion
- no hidden blockers

## Success Metrics

- zero hard-rule regressions
- zero stale blocked issues without owner action
- zero overlapping write work in the same area
- first-pass validation rate rising
- PR cycle time falling without compliance loss
- runner utilization high, local machine stable

## Rollout Order

1. lock the company goal
2. stand up the 30-role org
3. create the project and recurring governance tasks
4. route all code work through isolated workspaces
5. move validation onto the runner server
6. enforce review and merge gates
7. measure throughput only after compliance is stable

