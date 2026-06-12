---
title: OpenClaw TweetClaw Routine
summary: Schedule X/Twitter signal review through an OpenClaw gateway agent
---

This guide shows how to run a recurring Paperclip routine against an OpenClaw gateway agent that has the TweetClaw plugin installed.

Use this pattern when a company needs repeatable X/Twitter work such as:

- search tweets for launch feedback, customer mentions, competitors, or incidents
- search tweet replies for complaints, support signals, or product questions
- export followers or look up users before a campaign review
- monitor tweets and turn webhook events into Paperclip issues
- draft post tweets, post tweet replies, direct messages, media work, or giveaway draw follow-ups for board review

Paperclip stays the control plane. OpenClaw runs the agent. TweetClaw supplies the X/Twitter tools inside OpenClaw.

## Prerequisites

- A Paperclip company with an agent using the `openclaw_gateway` adapter.
- The OpenClaw gateway has completed the Paperclip invite and approval flow.
- The gateway can run OpenClaw plugin commands.
- An Xquik API key for account-backed TweetClaw actions.

Keep API keys out of Paperclip issue text, routine descriptions, screenshots, and OpenClaw chat prompts. Store the key in OpenClaw plugin config. If your gateway deployment reads tool credentials from runtime environment, bind the secret through Paperclip routine env instead of pasting it into the routine prompt.

## Install TweetClaw in OpenClaw

Run these commands in the OpenClaw environment used by the gateway agent:

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
openclaw plugins inspect tweetclaw --runtime
openclaw skills info tweetclaw
```

The `explore` tool lets the agent inspect the endpoint catalog without making live API calls. The `tweetclaw` tool invokes selected X/Twitter endpoints and remains subject to OpenClaw tool approval prompts.

## Create the Paperclip Routine

Create a routine assigned to the OpenClaw gateway agent:

```json
{
  "title": "Weekly X/Twitter Signal Review",
  "description": "Search X/Twitter for current product, competitor, and customer-support signals.",
  "assigneeAgentId": "{openclawGatewayAgentId}",
  "projectId": "{marketingOrSupportProjectId}",
  "goalId": "{growthOrSupportGoalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

Then add a schedule trigger:

```json
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "America/Los_Angeles"
}
```

For event-driven monitoring, add a webhook trigger and point TweetClaw monitor notifications at the generated Paperclip trigger URL.

## Routine Prompt

Use a focused prompt so each run leaves an auditable Paperclip issue:

```text
Use TweetClaw from this OpenClaw session to run a read-only X/Twitter signal review.

Search tweets and tweet replies for:
- our product name
- our support handle
- our top 3 competitor names
- this week's launch keywords

Return:
- the exact search queries used
- up to 10 source tweet URLs with author handles and timestamps
- short labels for customer support, product feedback, competitor signal, launch response, or risk
- a concise recommendation for the next Paperclip issue

Do not post tweets, post tweet replies, send direct messages, upload media, download private media, create monitors, create webhooks, or run giveaway draws during this routine. If you recommend one of those actions, create a separate Paperclip issue that asks the board operator to approve the action and includes the source links.
```

## Output Checklist

Each routine run should leave a comment or work product with:

- source tweet URLs and reply URLs
- the TweetClaw endpoint or catalog result used
- the query terms, account handles, and time window
- a short risk note for any recommended write, direct message, monitor, webhook, media, or giveaway draw action
- the next Paperclip issue to approve or perform follow-up work

## Approval Boundaries

Default to read-only work inside recurring routines.

Use a separate issue-thread confirmation or board-owned issue before actions that affect an X/Twitter account, including post tweets, post tweet replies, direct messages, media upload, authenticated media download, monitor creation, webhook creation, profile changes, or giveaway draws.

OpenClaw also prompts before write-like TweetClaw tool calls. Review the structured request before allowing the tool call.

## Verification

After setup:

1. Manually run the routine from Paperclip.
2. Confirm the run is assigned to the OpenClaw gateway agent.
3. Confirm the OpenClaw transcript contains `explore` and, when needed, read-only `tweetclaw` tool calls.
4. Confirm the Paperclip issue includes source links and no secret values.
5. Confirm no X/Twitter write, direct message, media, monitor, webhook, profile, or giveaway draw action occurred without a separate approval path.

See [Routines](/api/routines), [Adapters Overview](/adapters/overview), and [Running OpenClaw in Docker](/guides/openclaw-docker-setup) for the underlying Paperclip and OpenClaw setup details.
