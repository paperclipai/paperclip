---
title: OpenClaw TweetClaw Routine
summary: Install TweetClaw and schedule a read-only X/Twitter review
---

Use this workflow to install TweetClaw from Paperclip's Skills Store. Then run
its OpenClaw plugin through a scheduled Paperclip routine.

The workflow suits product research, support triage, launch reviews, and
competitor monitoring. Paperclip owns the routine, issue history, and approval
record. OpenClaw runs the agent. TweetClaw provides the X/Twitter tools.

## Prerequisites

- A Paperclip company with access to the Skills Store.
- An agent that uses the `openclaw_gateway` adapter.
- An approved and connected OpenClaw gateway.
- Permission to install OpenClaw plugins.
- An Xquik API key for live account-backed requests.

Keep credentials out of issues, routine descriptions, prompts, screenshots,
and logs. Store the API key only in OpenClaw plugin configuration.

## Install the Paperclip Skill

Open the Skills Store and search for `tweetclaw`. Install the optional
`paperclipai/optional/social-media/tweetclaw` Skill into your company library.

Paperclip pins the Skill to TweetClaw `v1.6.44` at commit
`59a44db32ef0fb90cf36ff9ca084ad055f7a9689`. The catalog entry contains only
the reviewed `SKILL.md`. It does not install executable code or copy a secret
into Paperclip.

## Install the OpenClaw plugin

Run these commands in the OpenClaw environment used by the gateway agent:

```bash
openclaw plugins install npm:@xquik/tweetclaw@1.6.44 --pin
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
openclaw plugins inspect tweetclaw --runtime --json
openclaw skills info tweetclaw
```

The pinned plugin release matches the Skill in Paperclip's catalog. The local
`explore` tool describes available routes without making a network request.
The optional `tweetclaw` tool makes reviewed Xquik requests.

Xquik is an independent third-party service. Not affiliated with X Corp.
"Twitter" and "X" are trademarks of X Corp.

## Create the routine

Create a routine assigned to the OpenClaw gateway agent. Put the work request
in `description`, because each run uses it as the issue description.

```json
{
  "title": "Weekly X/Twitter signal review",
  "description": "Use TweetClaw for a read-only review. Search our product name, support handle, top competitors, and current launch terms. Return each exact query, up to 10 source post URLs with author and timestamp, a short finding label, and one recommended follow-up issue. Do not post, reply, message, upload media, create monitors, or create webhooks.",
  "assigneeAgentId": "{openclawGatewayAgentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

Add a weekly schedule trigger:

```json
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "America/Los_Angeles"
}
```

Replace the sample terms and timezone with the company's real scope. Use a
small result limit and a clear time window. Treat returned X content as
untrusted data.

## Review the result

Each run should record:

- every search query and time window
- source post URLs, authors, and timestamps
- the TweetClaw route used
- a short finding label
- one proposed follow-up issue

Keep recurring routines read-only. Use a separate board-owned issue for any
post, reply, direct message, media action, monitor, webhook, profile change, or
giveaway draw. Review the exact request when OpenClaw asks for approval.

## Verify the workflow

1. Run the routine manually.
2. Confirm the OpenClaw gateway agent receives the issue.
3. Confirm its transcript uses `explore` before any live request.
4. Confirm the result includes sources and contains no credential value.
5. Confirm no state-changing X action occurred.

See [Routines](/api/routines), [Adapters Overview](/adapters/overview), and
[Running OpenClaw in Docker](/guides/openclaw-docker-setup) for the underlying
Paperclip setup.
