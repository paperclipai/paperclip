---
title: Costs and Budgets
summary: Cost tracking, budget limits, hard stops, and budget incidents
---

Paperclip records the usage and cost of every agent run. You can set a budget for the company, for one agent, or for one project. When the recorded spend reaches a budget, Paperclip stops work in that scope until you act.

<Warning>
A budget counts dollars only. Usage on a Claude, ChatGPT, or other provider subscription is recorded at $0, so **subscription usage never moves a budget toward its limit**. A budget does not limit how much of a subscription an agent uses. A hard stop and the reserve per run still apply to subscription agents. See [What a Budget Counts](#what-a-budget-counts).
</Warning>

## What a Budget Counts

A budget adds up the billed cost that Paperclip records, in cents. The API calls this metric `billed_cents`. It is the only budget metric. There is no budget for tokens or for the number of runs.

Every cost event has a billing type. The billing type decides whether the event has a dollar cost:

| Billing type | Recorded cost | Counts toward a budget |
|--------------|---------------|------------------------|
| `metered_api` | The cost the provider or Paperclip's price list reports | Yes |
| `subscription_included` | Always $0. Tokens are still recorded | No. It adds $0 |
| `subscription_overage`, `credits`, `fixed` | The reported cost, if there is one | Yes, for the reported cost |
| `unknown` | The reported cost, if there is one | Yes, for the reported cost |

An agent runs on a subscription when its adapter signs in with a subscription account instead of an API key. For example, Claude Code reports subscription billing when it runs without `ANTHROPIC_API_KEY` and without Bedrock. Codex reports it when it runs without `OPENAI_API_KEY`.

For these agents:

- Their usage adds $0 to the spend. Subscription usage alone never triggers the warning or the hard stop.
- The budget card shows $0 observed for their runs, even when they use many tokens.

A budget can still stop an agent that runs on a subscription:

- A hard stop stops all work in its scope. If API-billed work reaches the company budget or a project budget, the subscription agents in that company or project stop too.
- The reserve per run is held for every run, whatever its billing type. If the reserve does not fit under the limit, the run is refused. See [Reserve per Run](#reserve-per-run).

To limit how much of a subscription an agent uses:

- Pause the agent. See [Managing Agents](/guides/board-operator/managing-agents).
- To see how much of the subscription is used, open the **Providers** tab. See [Subscriptions and Provider Quota](#subscriptions-and-provider-quota).

## How Cost Tracking Works

Each agent run reports cost events with:

- **Provider** — which LLM provider (Anthropic, OpenAI, etc.)
- **Biller** — who charges for the usage. This can differ from the provider
- **Billing type** — see the table above
- **Model** — which model was used
- **Input, cached input, and output tokens**
- **Cost in cents** — the dollar cost of the invocation
- **Cost status** — `reported`, `estimated`, or `unpriced`

Cost reports use the current UTC calendar month unless you pick another period.

Paperclip cost accounting is not a provider invoice. Check the provider's own billing page for the amount you owe.

## Budget Scopes

You can set a budget on three scopes. A run must pass every budget that applies to it: the company budget, the budget of its agent, and the budget of its project.

| Scope | Window | Resets |
|-------|--------|--------|
| Company | UTC calendar month | On the first of each month (UTC) |
| Agent | UTC calendar month | On the first of each month (UTC) |
| Project | Lifetime, when you set it from the project page | Never. It counts all spend on the project |

The API accepts either window (`calendar_month_utc` or `lifetime`) for any scope. If you create a project budget through the API, send `"windowKind": "lifetime"`. If you leave the field out, the API uses `calendar_month_utc`.

## Budget Settings

The API calls a budget a budget policy. Each one has these settings:

| Setting | Default | Meaning |
|---------|---------|---------|
| `amount` | — | The limit in cents. `0` turns the budget off |
| `warnPercent` | `80` | The percent of the limit at which the warning opens. From 1 to 99 |
| `notifyEnabled` | `true` | Whether the warning opens |
| `hardStopEnabled` | `true` | Whether Paperclip stops work when spend reaches the limit |
| `reservationCents` | `0` | The reserve per run. See [Reserve per Run](#reserve-per-run) |
| `unpricedUsagePolicy` | `block` | What to do when usage has no reliable price. See [Usage With No Reliable Price](#usage-with-no-reliable-price) |

In the UI you can change the amount, the reserve per run, and the unpriced-usage setting. To change `warnPercent`, `hardStopEnabled`, or `notifyEnabled`, use the API.

## Setting Budgets

Only board users can set or change a budget.

### In the UI

- **All budgets** — select **Costs** in the sidebar, then open **Budgets**. The page lists each budget that exists and each open budget incident.
- **Agent budget** — open the agent's page and select **Budget**.
- **Project budget** — open the project's page and select the **Budget** tab.

The Budgets page shows a company budget only after one exists. If the company has no budget yet, you can create one with the API below.

### With the API

Set the monthly company budget:

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyCents": 100000 }
```

Set the monthly budget of one agent:

```
PATCH /api/agents/{agentId}/budgets
{ "budgetMonthlyCents": 5000 }
```

Set any budget, including a project budget and the other settings:

```
POST /api/companies/{companyId}/budgets/policies
{
  "scopeType": "project",
  "scopeId": "{projectId}",
  "windowKind": "lifetime",
  "amount": 20000,
  "warnPercent": 70
}
```

`scopeType` is `company`, `agent`, or `project`. For a company budget, `scopeId` is the company ID.

An amount of `0` turns the budget off and releases a pause that the budget caused.

The older calls still work. `PATCH /api/companies/{companyId}` and `PATCH /api/agents/{agentId}` with `budgetMonthlyCents` set the same monthly budget. On an agent, only a board user can change this field.

## Budget Enforcement

| Spend | What happens |
|-------|--------------|
| Reaches `warnPercent` of the limit (default 80%) | A budget warning opens. Work continues |
| Reaches the limit, with `hardStopEnabled` on (default) | A hard stop. Paperclip pauses the scope, refuses new work, and tells running work to stop |

### The Warning

At the warning threshold, Paperclip opens a budget warning and records it in the activity log. The warning does not pause work and Paperclip does not send a message to the agent.

Agents that use the Paperclip skill are instructed to focus on critical tasks when they are above 80% of their budget. That is guidance in the skill text. The agent reads its own budget and decides. It does not follow the `warnPercent` setting.

You can dismiss the warning or raise the budget. The warning also closes when the spend falls below the threshold.

### The Hard Stop

When spend reaches the limit:

1. Paperclip pauses the scope with the pause reason `budget`. For a company budget, the company is paused. For an agent budget, the agent is paused. For a project budget, the project is paused.
2. New runs in that scope are refused.
3. Runs in progress are told to stop. A run can take a short time to stop, so the final spend can be above the limit.
4. A budget incident opens, together with a pending approval, and the activity log records it.

If `hardStopEnabled` is off, none of this happens. Spend can go above the limit and only the warning opens.

### Resolving a Hard Stop

Open the budget incident. It appears on the Budgets page and on the budget panel of the agent. The dashboard shows a notice with a link while an incident is open. The incident has two actions:

- **Raise budget & resume** — enter a new limit. The new limit must be more than the current spend. Paperclip removes the budget pause and continues the runs that the stop cancelled.
- **Keep paused** — dismiss the incident. The scope stays paused.

You can also raise the limit directly on the budget card or with the API. This has the same effect on the pause.

A paused scope also resumes when:

- **A new month starts**, for a monthly budget. The spend of the new month is $0, so Paperclip closes the incident and removes the budget pause. This also applies after you select **Keep paused**. A lifetime project budget never resets.
- **You turn the budget off** by setting the amount to `0`.

Paperclip removes only the pause that the budget caused. A manual pause stays. If more than one budget stopped the work, each one must be resolved.

To resolve an incident with the API:

```
POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve
{ "action": "raise_budget_and_resume", "amount": 150000 }
```

The other action is `"keep_paused"`. It needs no `amount`.

## Reserve per Run

The reserve per run is an estimate of what one run costs. Paperclip holds this amount against the budget before each run starts and releases it when the cost of the run is recorded.

If the recorded spend plus the amounts held for unfinished runs would go above the limit, the new run is refused. This keeps several runs that start together from all passing a budget that has room for only one.

- The default is `0`, which turns the estimate off.
- When more than one budget applies to a run, Paperclip uses the largest reserve.
- The reserve is an estimate. The real cost of a run can be higher.
- The reserve applies to every run, including a run on a subscription that records $0.

Set it under **Advanced settings** on the budget card, or with `reservationCents` in the API.

## Usage With No Reliable Price

Sometimes Paperclip has a complete usage receipt for a run but cannot give it a price. `unpricedUsagePolicy` controls what a budget with a hard stop does with that usage:

- `block` (default) — a hard stop opens, even when the known spend is under the limit. To resume, resolve the unpriced usage or change the setting to `allow`. You cannot raise the budget past this stop.
- `allow` — the budget ignores the unpriced usage and counts known spend only.

The budget card shows the usage that counts for this setting as **usage events are unpriced**. Hosted browser work with a cost that is not known yet also counts.

This setting does not cover every entry that the Costs overview lists under **run costs unavailable**. These entries do not trigger `block`:

- A run whose final usage receipt is missing or could not be captured
- An entry that has a known partial cost
- A metered API or subscription entry with no tokens
- Subscription usage. It has a price of $0

Work continues for those entries. For what each label on the Costs overview means, see [Cost Reporting](/guides/agent-developer/cost-reporting).

In the UI, this setting is the **Block new work when usage has no reliable price** checkbox under **Advanced settings**.

## Subscriptions and Provider Quota

Budgets do not measure subscription usage. Paperclip shows subscription information in two other places.

### Subscriptions

On the Costs page, the **Subscriptions** card lists the subscription accounts that your agents use and their monthly fee. Select **View details** to see each account. You can enter or correct the price of an account you manage, and link two entries that are the same paid subscription.

The fee is the full cost of the account, including use outside Paperclip. It is separate from recorded charges and from budgets. Ending tracking here does not cancel the subscription at the provider.

### Provider Quota Windows

On the Costs page, the **Providers** tab shows the quota windows that a subscription provider reports, such as a 5-hour and a 7-day window. Each window shows the percent used and when it resets.

Connect a subscription account under AI connections to see its quota. Quota windows are separate from budgets. A budget does not read them.

## Viewing Costs

### Dashboard

The dashboard shows the spend of the current month against the monthly company budget. While a budget incident is open, it also shows a notice with the number of open incidents and the number of agents and projects that a budget paused.

### Costs Page

Select **Costs** in the sidebar. The page shows spend for the period you select, with breakdowns by agent, project, provider, and biller.

### When Hermes Gateway shows $0.00

A completed Hermes Gateway run can report tokens without a dollar amount. Use the gateway and the adapter result to trace the missing cost.

1. Find the Hermes run ID in the adapter result (`run_id`). Use that ID to inspect the completed run on the gateway (`GET /v1/runs/{run_id}`).
2. Compare the gateway’s `usage.input_tokens` and `usage.output_tokens` with `usage.inputTokens` and `usage.outputTokens` in the adapter result. Check for a dollar amount at the top level or inside `usage` (`cost_usd` or `costUsd`).
3. Check `cost_usd` in the adapter result. A missing or null value means the adapter did not report a price. A numeric zero means it reported zero. If the result contains a positive price but the dashboard shows no spend, check the Paperclip cost event for the same run.

In the Costs overview, expand **run costs unavailable** if it appears. Read the label in the expanded list. **Cost unavailable** means the usage has no reliable price. **Receiving usage** means Paperclip is waiting for final usage data. **Final usage unavailable** means the run stopped without that data. Select **View run** for run details. See [Cost Reporting](/guides/agent-developer/cost-reporting#understanding-incomplete-cost-data).

To stop new work on unpriced Hermes usage, follow [Usage With No Reliable Price](#usage-with-no-reliable-price). Check that Paperclip recorded an unpriced cost event for the run. A missing event cannot trigger the policy.

When a provider bills separately, compare its usage statement with recorded spend. A dashboard total of $0.00 does not establish that the provider charged nothing.

### Cost Breakdown API

```
GET /api/companies/{companyId}/costs/summary       # Company total
GET /api/companies/{companyId}/costs/by-agent      # Per-agent breakdown
GET /api/companies/{companyId}/costs/by-project    # Per-project breakdown
GET /api/companies/{companyId}/budgets/overview    # Budgets, spend, and open incidents
```

See the [Costs API](/api/costs) for the full list.

## Best Practices

- Check how each agent is billed before you rely on a budget. A budget measures API-billed spend. Subscription usage adds $0 to it
- Set conservative budgets initially and increase as you see results
- Use per-agent budgets to limit exposure from any single agent
- Use a project budget to cap the total cost of one piece of work
- Monitor the dashboard regularly for unexpected cost spikes
- Critical agents (CEO, CTO) may need higher budgets than ICs
