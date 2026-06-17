# SINK DINK India Controlled Agent Workflow Runbook

Status: planned production layer after AI campaign QA-gated output passed.

## Current verified base

- Render/Paperclip app is live.
- Hugging Face media worker is generating `final_reel.mp4`.
- Supabase job + audit logging is working.
- AI campaign route is live: `/api/sink-dink/ai-campaign/create`.
- QA-gated output is passing with `qaScore` and `publishingBlocked: true`.
- Agents remain in `paused_human_approval` mode.

## Non-negotiable safety rule

Agents may research, plan, generate scripts, create media packs, and prepare upload-ready assets.

Agents must not auto-publish, auto-post, auto-spend money, or run uncontrolled loops.

Every final output must remain `pending_human_approval` until the human approves it.

## Next production layer

Add a controlled agent workflow wrapper over the existing AI campaign route.

Target route:

```text
/api/sink-dink/agent-workflow/start-day
```

Status route:

```text
/api/sink-dink/agent-workflow/status
```

## Intended agent chain

1. CEO Agent
   - Reads command.
   - Defines campaign goal.
   - Sets success criteria.
   - Keeps agents paused except controlled run.

2. Research Agent
   - Identifies SINK/DINK India content angles.
   - Avoids medical/legal/anti-family/anti-child claims.

3. Strategy Agent
   - Selects 5-10 reel topics.
   - Balances emotional, financial, relationship, and social-pressure themes.

4. Content Agent
   - Creates hooks, scripts, captions, hashtags.
   - Uses smart Hinglish, premium Instagram tone.

5. Media Worker
   - Sends approved media packs to HF worker.
   - Generates video/assets.

6. QA Agent
   - Checks hook quality, topic cleanliness, script length, caption, hashtags, MP4 presence, and blocked language.
   - Assigns QA score.

7. Approval Gate
   - Stores all output as pending human approval.
   - Blocks publishing.

## Response format for start-day route

```json
{
  "ok": true,
  "service": "sink-dink-controlled-agent-workflow",
  "mode": "controlled_human_approval",
  "agentsRunMode": "paused_human_approval",
  "humanApprovalRequired": true,
  "publishingBlocked": true,
  "workflowTrace": [
    {"agent": "CEO", "status": "completed", "summary": "..."},
    {"agent": "Research", "status": "completed", "summary": "..."},
    {"agent": "Strategy", "status": "completed", "summary": "..."},
    {"agent": "Content", "status": "completed", "summary": "..."},
    {"agent": "Media", "status": "completed", "summary": "..."},
    {"agent": "QA", "status": "completed", "summary": "..."},
    {"agent": "ApprovalGate", "status": "pending_human_approval", "summary": "..."}
  ],
  "campaign": {
    "batchId": "...",
    "successCount": 5,
    "failedCount": 0,
    "averageQaScore": 100,
    "results": []
  }
}
```

## Deploy gate checklist before coding

- Do not modify HF worker for this step.
- Do not modify existing working `/api/sink-dink/ai-campaign/create` behavior.
- Add new wrapper route only.
- Reuse existing campaign route logic or duplicate only minimal safe orchestration logic.
- Preserve `publishingBlocked: true`.
- Preserve `humanApprovalRequired: true`.
- Preserve `approvalStatus: pending_human_approval`.
- Add Supabase audit event for workflow summary.

## Test script after deploy

```js
(async () => {
  const r = await fetch("/api/sink-dink/agent-workflow/start-day", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      command: "CEO, aaj ka kaam start kro",
      topic: "SINK DINK India me family pressure aur personal freedom",
      count: 5,
      tone: "smart Hinglish, relatable, emotionally sharp, Instagram top-page style",
      durationSec: 25
    })
  });

  const data = await r.json();
  console.log("HTTP:", r.status);
  console.log(data);
  console.table(data.workflowTrace || []);
  console.table((data.campaign?.results || []).map(x => ({
    ok: x.ok,
    topic: x.topic,
    hook: x.hook,
    qaScore: x.qaScore,
    jobId: x.jobId,
    mp4: x.mp4
  })));
})();
```

## Acceptance criteria

- HTTP 200.
- Workflow trace visible.
- 5 campaign items generated.
- `qaScore` visible.
- `final_reel.mp4` links visible.
- `agentsRunMode` remains `paused_human_approval`.
- `publishingBlocked` remains true.
