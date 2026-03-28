# 预算策略与执行

## 背景

Paperclip 已将预算视为核心控制面职责：

- `doc/SPEC.md` 授权 Board 设置预算、暂停代理、暂停工作并覆盖任何预算。
- `doc/SPEC-implementation.md` 规定 V1 必须支持 UTC 月度预算窗口、软警告和硬自动暂停。
- 当前代码仅部分实现了上述意图。

目前系统仅具备有限的金额预算行为：

- 公司跟踪 `budgetMonthlyCents` 和 `spentMonthlyCents`
- 代理跟踪 `budgetMonthlyCents` 和 `spentMonthlyCents`
- `cost_events` 摄入时递增上述计数器
- 当代理超出月度预算时，代理被暂停

这留下了重大的产品空白：

- 没有项目预算模型
- 触及预算时不生成审批
- 没有通用预算策略系统
- 没有与预算挂钩的项目暂停语义
- 没有持久化事件跟踪以防止重复警告
- 没有将可执行消费预算与咨询性用量配额区分开来

本计划定义了 Paperclip 接下来应实现的具体预算模型。

## 产品目标

Paperclip 应允许运营人员：

1. 为代理和项目设置预算。
2. 了解预算是基于金额还是用量。
3. 在预算耗尽前收到警告。
4. 触及硬预算时自动暂停工作。
5. 通过清晰的 UI 批准、提高或从预算停止中恢复。
6. 在仪表盘、`/costs` 和范围详情页查看预算状态。

系统应将一件事说清楚：

- 预算是策略控制
- 配额是用量可见性

两者相关，但不是同一概念。

## Product Decisions

### V1 Budget Defaults

For the next implementation pass, Paperclip should enforce these defaults:

- agent budgets are recurring monthly budgets
- project budgets are lifetime total budgets
- hard-stop enforcement uses billed dollars, not tokens
- monthly windows use UTC calendar months
- project total budgets do not reset automatically

This gives a clean mental model:

- agents are ongoing workers, so monthly recurring budget is natural
- projects are bounded workstreams, so lifetime cap is natural

### Metric To Enforce First

The first enforceable metric should be `billed_cents`.

Reasoning:

- it works across providers, billers, and models
- it maps directly to real financial risk
- it handles overage and metered usage consistently
- it avoids cross-provider token normalization problems
- it applies cleanly even when future finance events are not token-based

Token budgets should not be the first hard-stop policy.
They should come later as advisory usage controls once the money-based system is solid.

### Subscription Usage Decision

Paperclip should separate subscription-included usage from billed spend:

- `subscription_included`
  - visible in reporting
  - visible in usage summaries
  - does not count against money budget
- `subscription_overage`
  - visible in reporting
  - counts against money budget
- `metered_api`
  - visible in reporting
  - counts against money budget

This keeps the budget system honest:

- users should not see "spend" rise for usage that did not incur marginal billed cost
- users should still see the token usage and provider quota state

### Soft Alert Versus Hard Stop

Paperclip should have two threshold classes:

- soft alert
  - creates visible notification state
  - does not create an approval
  - does not pause work
- hard stop
  - pauses the affected scope automatically
  - creates an approval requiring human resolution
  - prevents additional heartbeats or task pickup in that scope

Default thresholds:

- soft alert at `80%`
- hard stop at `100%`

These should be configurable per policy later, but they are good defaults now.

## Scope Model

### Supported Scope Types

Budget policies should support:

- `company`
- `agent`
- `project`

This plan focuses on finishing `agent` and `project` first while preserving the existing company budget behavior.

### Recommended V1.5 Policy Presets

- Company
  - metric: `billed_cents`
  - window: `calendar_month_utc`
- Agent
  - metric: `billed_cents`
  - window: `calendar_month_utc`
- Project
  - metric: `billed_cents`
  - window: `lifetime`

Future extensions can add:

- token advisory policies
- daily or weekly spend windows
- provider- or biller-scoped budgets
- inherited delegated budgets down the org tree

## Current Implementation Baseline

The current codebase is not starting from zero, but the existing shape is too ad hoc to extend safely.

### What Exists Today

- company and agent monthly cents counters
- cost ingestion that updates those counters
- agent hard-stop pause on monthly budget overrun

### What Is Missing

- project budgets
- generic budget policy persistence
- generic threshold crossing detection
- incident deduplication per scope/window
- approval creation on hard-stop
- project execution blocking
- budget timeline and incident UI
- distinction between advisory quota and enforceable budget

## Proposed Data Model

### 1. `budget_policies`

Create a new table for canonical budget definitions.

Suggested fields:

- `id`
- `company_id`
- `scope_type`
- `scope_id`
- `metric`
- `window_kind`
- `amount`
- `warn_percent`
- `hard_stop_enabled`
- `notify_enabled`
- `is_active`
- `created_by_user_id`
- `updated_by_user_id`
- `created_at`
- `updated_at`

Notes:

- `scope_type` is one of `company | agent | project`
- `scope_id` is nullable only for company-level policy if company is implied; otherwise keep it explicit
- `metric` should start with `billed_cents`
- `window_kind` starts with `calendar_month_utc | lifetime`
- `amount` is stored in the natural unit of the metric

### 2. `budget_incidents`

Create a durable record of threshold crossings.

Suggested fields:

- `id`
- `company_id`
- `policy_id`
- `scope_type`
- `scope_id`
- `metric`
- `window_kind`
- `window_start`
- `window_end`
- `threshold_type`
- `amount_limit`
- `amount_observed`
- `status`
- `approval_id` nullable
- `activity_id` nullable
- `resolved_at` nullable
- `created_at`
- `updated_at`

Notes:

- `threshold_type`: `soft | hard`
- `status`: `open | acknowledged | resolved | dismissed`
- one open incident per policy per threshold per window prevents duplicate approvals and alert spam

### 3. Project Pause State

Projects need explicit pause semantics.

Recommended approach:

- extend project status or add a pause field so a project can be blocked by budget
- preserve whether the project is paused due to budget versus manually paused

Preferred shape:

- keep project workflow status as-is
- add execution-state fields:
  - `execution_status`: `active | paused | archived`
  - `pause_reason`: `manual | budget | system | null`

If that is too large for the immediate pass, a smaller version is:

- add `paused_at`
- add `pause_reason`

The key requirement is behavioral, not cosmetic:
Paperclip must know that a project is budget-paused and enforce it.

### 4. Compatibility With Existing Budget Columns

Existing company and agent monthly budget columns should remain temporarily for compatibility.

Migration plan:

1. keep reading existing columns during transition
2. create equivalent `budget_policies` rows
3. switch enforcement and UI to policies
4. later remove or deprecate legacy columns

## Budget Engine

Budget enforcement should move into a dedicated service.

Current logic is buried inside cost ingestion.
That is too narrow because budget checks must apply at more than one execution boundary.

### Responsibilities

New service: `budgetService`

Responsibilities:

- resolve applicable policies for a cost event
- compute current window totals
- detect threshold crossings
- create incidents, activities, and approvals
- pause affected scopes on hard-stop
- provide preflight enforcement checks for execution entry points

### Canonical Evaluation Flow

When a new `cost_event` is written:

1. persist the `cost_event`
2. identify affected scopes
   - company
   - agent
   - project
3. fetch active policies for those scopes
4. compute current observed amount for each policy window
5. compare to thresholds
6. create soft incident if soft threshold crossed for first time in window
7. create hard incident if hard threshold crossed for first time in window
8. if hard incident:
   - pause the scope
   - create approval
   - create activity event
   - emit notification state

### Preflight Enforcement Checks

Budget enforcement cannot rely only on post-hoc cost ingestion.

Paperclip must also block execution before new work starts.

Add budget checks to:

- scheduler heartbeat dispatch
- manual invoke endpoints
- assignment-driven wakeups
- queued run promotion
- issue checkout or pickup paths where applicable

If a scope is budget-paused:

- do not start a new heartbeat
- do not let the agent pick up additional work
- present a clear reason in API and UI

### Active Run Behavior

When a hard-stop is triggered while a run is already active:

- mark scope paused immediately for future work
- request graceful cancellation of the current run
- allow normal cancellation timeout behavior
- write activity explaining that pause came from budget enforcement

This mirrors the general pause semantics already expected by the product.

## Approval Model

Budget hard-stops should create a first-class approval.

### New Approval Type

Add approval type:

- `budget_override_required`

Payload should include:

- `scopeType`
- `scopeId`
- `scopeName`
- `metric`
- `windowKind`
- `thresholdType`
- `budgetAmount`
- `observedAmount`
- `windowStart`
- `windowEnd`
- `topDrivers`
- `paused`

### Resolution Actions

The approval UI should support:

- raise budget and resume
- resume once without changing policy
- keep paused

Optional later action:

- disable budget policy

### Soft Alerts Do Not Need Approval

Soft alerts should create:

- activity event
- dashboard alert
- inbox notification or similar board-visible signal

They should not create an approval by default.

## Notification And Activity Model

Budget events need obvious operator visibility.

Required outputs:

- activity log entry on threshold crossings
- dashboard surface for active budget incidents
- detail page banner on paused agent or project
- `/costs` summary of active incidents and policy health

Later channels:

- email
- webhook
- Slack or other integrations

## API Plan

### Policy Management

Add routes for:

- list budget policies for company
- create budget policy
- update budget policy
- archive or disable budget policy

### Incident Surfaces

Add routes for:

- list active budget incidents
- list incident history
- get incident detail for a scope

### Approval Resolution

Budget approvals should use the existing approval system once the new approval type is added.

Expected flows:

- create approval on hard-stop
- resolve approval by changing policy and resuming
- resolve approval by resuming once

### Execution Errors

When work is blocked by budget, the API should return explicit errors.

Examples:

- agent invocation blocked because agent budget is paused
- issue execution blocked because project budget is paused

Do not silently no-op.

## UI Plan

Budgeting should be visible in the places where operators make decisions.

### `/costs`

Add a budget section that includes:

- active budget incidents
- policy list with scope, window, metric, and threshold state
- progress bars for current period or total
- clear distinction between:
  - spend budget
  - subscription quota
- quick actions:
  - raise budget
  - open approval
  - resume scope if permitted

The page should make this visual distinction obvious:

- Budget
  - enforceable spend policy
- Quota
  - provider or subscription usage window

### Agent Detail

Add an agent budget card:

- monthly budget amount
- current month spend
- remaining spend
- status
- warning or paused banner
- link to approval if blocked

### Project Detail

Add a project budget card:

- total budget amount
- total spend to date
- remaining spend
- pause status
- approval link

Project detail should also show if issue execution is blocked because the project is budget-paused.

### Dashboard

Add a high-signal budget section:

- active budget breaches
- upcoming soft alerts
- counts of paused agents and paused projects due to budget

The operator should not have to visit `/costs` to learn that work has stopped.

## Budget Math

### What Counts Toward Budget

For V1.5 enforcement, include:

- `metered_api` cost events
- `subscription_overage` cost events
- any future request-scoped cost event with non-zero billed cents

Do not include:

- `subscription_included` cost events with zero billed cents
- advisory quota rows
- account-level finance events unless and until company-level financial budgets are added explicitly

### Why Not Tokens First

Token budgets should not be the first hard-stop because:

- providers count tokens differently
- cached tokens complicate simple totals
- some future charges are not token-based
- subscription tokens do not necessarily imply spend
- money remains the cleanest cross-provider enforcement metric

### Future Budget Metrics

Future policy metrics can include:

- `total_tokens`
- `input_tokens`
- `output_tokens`
- `requests`
- `finance_amount_cents`

But they should enter only after the money-budget path is stable.

## Migration Plan

### Phase 1: Foundation

- add `budget_policies`
- add `budget_incidents`
- add new approval type
- add project pause metadata

### Phase 2: Compatibility

- backfill policies from existing company and agent monthly budget columns
- keep legacy columns readable during migration

### Phase 3: Enforcement

- move budget logic into dedicated service
- add hard-stop incident creation
- add activity and approval creation
- add execution guards on heartbeat and invoke paths

### Phase 4: UI

- `/costs` budget section
- agent detail budget card
- project detail budget card
- dashboard incident summary

### Phase 5: Cleanup

- move all reads/writes to `budget_policies`
- reduce legacy column reliance
- decide whether to remove old budget columns

## Tests

Required coverage:

- agent monthly budget soft alert at 80%
- agent monthly budget hard-stop at 100%
- project lifetime budget soft alert
- project lifetime budget hard-stop
- `subscription_included` usage does not consume money budget
- `subscription_overage` does consume money budget
- hard-stop creates one incident per threshold per window
- hard-stop creates approval and pauses correct scope
- paused project blocks new issue execution
- paused agent blocks new heartbeat dispatch
- policy update and resume clears or resolves active incident correctly
- dashboard and `/costs` surface active incidents

## Open Questions

These should be explicitly deferred unless they block implementation:

- Should project budgets also support monthly mode, or is lifetime enough for the first release?
- Should company-level budgets eventually include `finance_events` such as OpenRouter top-up fees and Bedrock provisioned charges?
- Should delegated budget editing be limited by org hierarchy in V1, or remain board-only in the UI even if the data model can support delegation later?
- Do we need "resume once" immediately, or can first approval resolution be "raise budget and resume" plus "keep paused"?

## Recommendation

Implement the first coherent budgeting system with these rules:

- Agent budget = monthly billed dollars
- Project budget = lifetime billed dollars
- Hard-stop = auto-pause + approval
- Soft alert = visible warning, no approval
- Subscription usage = visible quota and token reporting, not money-budget enforcement

This solves the real operator problem without mixing together spend control, provider quota windows, and token accounting.
