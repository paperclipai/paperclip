---
title: Using a Claude or OpenAI Subscription
summary: What Paperclip does with a connected subscription, what it costs, and how to stay in control
---

## What does Paperclip do with my subscription?

Your agents run on it. When an agent works, it uses the model through your account.

To connect, you sign in on the provider's own page and confirm with a code. You do not type your provider password into Paperclip. Paperclip stores the sign-in credential it gets back as an encrypted secret.

## Does connecting cost me anything extra?

Usage comes out of the plan you already pay for. Paperclip records subscription usage at $0.

If your plan has extra usage turned on at the provider, the provider can bill you for use above the plan. Paperclip still records those runs at $0. Check the provider's billing page for what you owe.

## When do my agents use it?

Only while a run is in progress. A run starts when:

- A task is assigned to an agent, by you or by another agent.
- Someone comments on an agent's task.
- You approve something an agent asked for.
- A routine runs and creates a task for an agent.

An agent can also run on a timer. This is the **Heartbeat on interval** setting under **Run Policy**. Agents you add yourself start with it off. The first agent from setup has it on, every 5 minutes, but the timer starts a run only when that agent has a task in to-do or in progress.

## How do I see what has been used?

Select **Audit** in the sidebar, then **Costs**.

- The **Subscriptions** card shows your subscription accounts and the tokens your agents used.
- The **Providers** tab shows the usage windows your provider reports, with the percent used and the reset time.

You can also open **Connectors**, open the account, and select **Check usage**.

## Can I set a limit?

Not for a subscription. Paperclip has no setting that caps tokens or the share of your plan that agents may use.

Budgets count dollars only. Subscription usage is recorded at $0, so it never moves a budget toward its limit. See [Costs and Budgets](/guides/board-operator/costs-and-budgets).

To use less, pause an agent or a task, or disconnect.

## How do I stop or pause?

- **Pause an agent.** Open the agent and select **Pause**. Paperclip cancels its running work and starts no new run until you select **Resume**.
- **Pause one task.** On a running task, select **Pause work**.
- **Disconnect.** Open **Connectors**, open the account, and select **Revoke identity**. New runs on that account are blocked. A run already in progress can keep its sign-in until it ends.

## What happens when my plan reaches its limit?

The run fails, and the task can show **Usage limit reached**.

If the provider reports when the limit resets, Paperclip tries again at that time. If not, Paperclip tries again after one hour, or asks you to check your provider account and retry.

Your own use of Claude or ChatGPT counts against the same limit.

## Can I use an API key instead?

Yes. On the connect step, select **Use API key instead**.

The provider then bills you for each use. Paperclip records the cost in dollars, and budgets apply to it.
