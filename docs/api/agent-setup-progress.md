---
title: Agent Setup Progress
summary: A live checklist a person's own agent fills in while it sets something up for them
---

When Paperclip offers "Set it up with your agent", the setup page can show a live checklist of what the person's own agent (for example Claude Code on their computer) is doing. The page creates the checklist and puts its URLs and a token in the setup prompt. The agent sets the checklist, updates each step and finishes; each change appears on the page right away.

The agent needs no Paperclip sign-in. Its token can only write to this one checklist, works for six hours, and allows up to 300 updates. Paperclip keeps only a hash of the token. The prompt that carries the token is a credential for this checklist: it is meant for the person's own agent, not for sharing. The create response is sent with `Cache-Control: no-store`. A finished checklist refuses further updates (`409`), and checklists are deleted a day after they expire: a company's own when it creates a new one, and every company's once at server start (never as a recurring scan).

## Create a Checklist (Board)

```
POST /api/companies/{companyId}/agent-setup-progress
{ "purpose": "aws_connection", "subjectId": "<connection id>" }
```

Board only. For `aws_connection`, `subjectId` must name a connection of this company, and the caller must be allowed to configure it (its creator or a connection manager); otherwise `422`, `404` or `403`. The `201` response returns the checklist, the token (shown only here) and the agent's URLs:

```json
{
  "progress": { "id": "…", "status": "waiting", "items": [], "summary": null, "expiresAt": "…" },
  "token": "pcsp_…",
  "urls": {
    "checklist": "https://paperclip.example.com/api/agent-setup-progress/{id}/checklist",
    "item": "https://paperclip.example.com/api/agent-setup-progress/{id}/items/{key}",
    "finish": "https://paperclip.example.com/api/agent-setup-progress/{id}/finish"
  }
}
```

`GET /api/agent-setup-progress/{id}` reads it. Only the person who started the setup can read it; anyone else, including another company, gets the same `404` as for a missing checklist. Each agent update is also sent as an `agent_setup_progress.updated` live event carrying only the checklist ID.

## Agent Requests

Each request sends `Authorization: Bearer <token>` and JSON.

| Request | Body | Effect |
| --- | --- | --- |
| `PUT …/checklist` | `{ "items": [{ "key": "check-account", "title": "Check the AWS account" }] }` | Replaces the checklist: 1 to 20 items; keys are lowercase letters, numbers, `-` and `_` (up to 40); titles up to 120 characters. |
| `POST …/items/{key}` | `{ "status": "in_progress", "detail": "…" }` | Sets one step's status (`pending`, `in_progress`, `done` or `failed`) and an optional detail (up to 500 characters); omit `detail` to keep it, or send `null` to clear it. |
| `POST …/finish` | `{ "status": "done", "summary": "…" }` | Finishes the setup. `done` ticks off every step (the agent's verdict); `failed` keeps the steps as they were. The summary is shown on the page. After either, further updates get `409`. |

The checklist stays `in_progress` until the agent finishes, even with every step done, because only the finish carries the summary. Each change is recorded on the activity history (never the token). The setup page keeps the same checklist if the person leaves the step and comes back, and offers to start again once a prompt expires.

Errors: `400` for an invalid body, `401` when the token is missing or does not open this checklist, `404` for an unknown item, `409` when another update changed the checklist at the same time (send it again) or the setup already finished, `410` once the token expired, and `429` after 300 updates.

## Adding It to Another Setup Page

In the UI, `useAgentSetupProgress` (in `ui/src/components/AgentSetupProgress.tsx`) creates the checklist. `agentSetupProgressInstructions` writes the prompt section with the agent's commands, and `AgentSetupProgressPanel` shows the checklist. A new page adds its purpose to `AGENT_SETUP_PROGRESS_PURPOSES` in `@paperclipai/shared`.
