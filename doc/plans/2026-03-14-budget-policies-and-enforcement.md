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

## 产品决策

### V1 预算默认值

在下一轮实现中，Paperclip 应执行以下默认设置：

- 代理预算为周期性月度预算
- 项目预算为生命周期总额预算
- 硬停止执行使用计费金额，而非 token
- 月度窗口使用 UTC 自然月
- 项目总额预算不自动重置

这提供了清晰的心智模型：

- 代理是持续工作的，因此月度循环预算是自然的选择
- 项目是有边界的工作流，因此生命周期上限是自然的选择

### 首先执行的指标

第一个可执行指标应为 `billed_cents`。

理由：

- 适用于所有提供商、计费方和模型
- 直接映射到真实的财务风险
- 一致地处理超额用量和计量用量
- 避免跨提供商的 token 规范化问题
- 即使未来的财务事件不基于 token，仍可干净地应用

Token 预算不应作为第一个硬停止策略。
等基于金额的系统稳固后，它们应作为咨询性用量控制稍后加入。

### 订阅用量决策

Paperclip 应将订阅内含用量与计费消费区分开来：

- `subscription_included`
  - 在报告中可见
  - 在用量摘要中可见
  - 不计入金额预算
- `subscription_overage`
  - 在报告中可见
  - 计入金额预算
- `metered_api`
  - 在报告中可见
  - 计入金额预算

这确保了预算系统的诚实性：

- 用户不应看到"消费"因未产生边际计费成本的用量而增加
- 用户仍应看到 token 用量和提供商配额状态

### 软警告与硬停止

Paperclip 应有两个阈值等级：

- 软警告
  - 创建可见的通知状态
  - 不创建审批
  - 不暂停工作
- 硬停止
  - 自动暂停受影响的范围
  - 创建需要人工处理的审批
  - 阻止该范围内的额外心跳或任务接取

默认阈值：

- 软警告在 `80%`
- 硬停止在 `100%`

这些应在后续可按策略配置，但目前作为默认值是合适的。

## 范围模型

### 支持的范围类型

预算策略应支持：

- `company`
- `agent`
- `project`

本计划优先完成 `agent` 和 `project`，同时保留现有的公司预算行为。

### 推荐的 V1.5 策略预设

- 公司
  - metric: `billed_cents`
  - window: `calendar_month_utc`
- 代理
  - metric: `billed_cents`
  - window: `calendar_month_utc`
- 项目
  - metric: `billed_cents`
  - window: `lifetime`

未来扩展可以添加：

- token 咨询策略
- 每日或每周消费窗口
- 提供商或计费方范围的预算
- 沿组织树向下继承的委托预算

## 当前实现基准

当前代码库并非从零开始，但现有结构过于临时性，无法安全地扩展。

### 现有内容

- 公司和代理的月度金额计数器
- 更新这些计数器的费用摄入逻辑
- 代理在超出月度预算时的硬停止暂停

### 缺失内容

- 项目预算
- 通用预算策略持久化
- 通用阈值越过检测
- 按范围/窗口的事件去重
- 硬停止时创建审批
- 项目执行阻止
- 预算时间线和事件 UI
- 咨询性配额与可执行预算的区分

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
