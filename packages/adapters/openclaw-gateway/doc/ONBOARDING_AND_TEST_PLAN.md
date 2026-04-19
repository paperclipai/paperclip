# OpenClaw Gateway Onboarding and Test Plan

## Scope
This plan is now **gateway-only**. Paperclip supports OpenClaw through `openclaw_gateway` only.

- Removed path: legacy `openclaw` adapter (`/v1/responses`, `/hooks/*`, SSE/webhook transport switching)
- Supported path: `openclaw_gateway` over WebSocket (`ws://` or `wss://`)

## Requirements
1. OpenClaw test image must be stock/clean every run.
2. Onboarding must work from one primary prompt pasted into OpenClaw (optional one follow-up ping allowed).
3. Device auth stays enabled by default; pairing is persisted via `adapterConfig.devicePrivateKeyPem`.
4. Invite/access flow must be secure:
- invite prompt endpoint is board-permission protected
- CEO agent is allowed to invoke the invite prompt endpoint for their own company
5. E2E pass criteria must include the 3 functional task cases.

## Current Product Flow
1. Board/CEO opens company settings.
2. Click `Generate OpenClaw Invite Prompt`.
3. Paste generated prompt into OpenClaw chat.
4. OpenClaw submits invite acceptance with:
- `adapterType: "openclaw_gateway"`
- `agentDefaultsPayload.url: ws://... | wss://...`
- `agentDefaultsPayload.headers["x-openclaw-token"]`
5. Board approves join request.
6. OpenClaw claims API key and installs/uses Paperclip skill.
7. First task run may trigger pairing approval once; after approval, pairing persists via stored device key.

## Devin Non-Production Validation Handoff

Do not use the current `localhost:3100` Paperclip surface for the remaining OpenClaw validation gaps. Repo notes identify that checkout as the live Mac mini instance.

Devin should boot an isolated Paperclip instance from this repo and use that instance only for the two validation drills.

```bash
export PAPERCLIP_HOME=/tmp/paperclip-openclaw-validation
export PAPERCLIP_INSTANCE_ID=openclaw_validation
export PORT=3101
pnpm paperclipai run --bind tailnet
```

Required isolation checks:

- health succeeds on `http://127.0.0.1:3101/api/health`
- the instance root is `$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID`, not `~/.paperclip/instances/default`
- browser and API traffic use the new tailnet URL on port `3101`, not the live `:3100` surface

Use the standard authenticated bootstrap flow on that isolated instance before any board-only actions:

```bash
PAPERCLIP_HOME=/tmp/paperclip-openclaw-validation \
PAPERCLIP_INSTANCE_ID=openclaw_validation \
pnpm paperclipai auth bootstrap-ceo \
  --data-dir /tmp/paperclip-openclaw-validation \
  --base-url http://<tailnet-host>:3101
```

- accept the bootstrap invite on the isolated instance
- keep the resulting board session/cookie scoped to that instance
- create only these non-production companies there:
  - `openclaw-noassign-test`
  - `openclaw-quiet-test`

Use existing interfaces only:

- `POST /api/companies/{companyId}/agents`
- `POST /api/agents/{agentId}/keys`
- `PATCH /api/agents/{agentId}/permissions`
- `GET /api/agents/me`
- `GET /api/companies/{companyId}/dashboard`
- `GET /api/agents/me/inbox-lite`
- `GET /api/issues/{issueId}/heartbeat-context`
- `POST /api/companies/{companyId}/issues`
- `POST /api/issues/{issueId}/comments`
- `GET /api/companies/{companyId}/issues?status=todo,in_progress,blocked&limit=50`

After the isolated instance is ready, run the `No-Assign Fallback Drill` and `Quiet-Company Fallback Drill` below exactly as written.

Required output from Devin:

- company names used
- temporary agent ids
- parent issue id and child issue id for the no-assign drill
- whether the child was unassigned
- no-assign `@CEO` handoff comment id
- quiet-company target issue id
- quiet-company `@CEO` nudge comment id
- whether the duplicate nudge was skipped
- whether a fresh nudge was allowed after status or assignee changed
- confirmation that `GET /api/agents/me` showed `access.canAssignTasks = false`
- revoked key ids
- any blockers

Cleanup is mandatory:

- revoke every temporary key created for the drills
- pause or terminate both temporary agents
- leave both companies clearly labeled as non-production validation surfaces

## Recommended Live Ops-Manager Setup

- Stable agent name: `OpenClawOps`
- Heartbeat: enabled
- Permission grant: `tasks:assign`
- Role: ops-manager, not the CEO
- Expected heartbeat startup flow:
  1. `GET /api/agents/me`
  2. `GET /api/companies/{companyId}/dashboard`
  3. `GET /api/agents/me/inbox-lite`
  4. `GET /api/issues/{issueId}/heartbeat-context`
- Child issue rules:
  - always set `parentId` and `goalId`
  - include `projectId` when the parent has one
  - include `inheritExecutionWorkspaceFromIssueId` when the follow-up should stay in the same workspace
- CEO nudge rules:
  - comment with exact `@CEO`
  - use `/api/companies/{companyId}/issues?status=todo,in_progress,blocked&limit=50` for company-wide fallback targeting
  - skip duplicate nudges within 60 minutes unless assignee or status changed

## No-Assign Fallback Drill

Use a non-production company only.

- Company: `openclaw-noassign-test`
- Temporary agent: `OpenClawOps-NoAssign`
- Create the agent with the normal OpenClaw gateway adapter setup, but keep heartbeat disabled so the drill stays deterministic.
- Mint a temporary long-lived key with `POST /api/agents/{agentId}/keys`.
- Immediately remove assignment authority with `PATCH /api/agents/{agentId}/permissions` and `{"canCreateAgents":false,"canAssignTasks":false}`.
- Verify the branch is armed by calling `GET /api/agents/me` with the temporary key and confirming `access.canAssignTasks = false`.
- Seed one real parent issue for the drill with a valid `goalId`, plus `projectId` when available.
- Ask OpenClaw to run only the no-assign path:
  - read `GET /api/agents/me`
  - read `GET /api/companies/{companyId}/dashboard`
  - read `GET /api/agents/me/inbox-lite`
  - read `GET /api/issues/{issueId}/heartbeat-context`
  - create one child issue with `parentId`, `goalId`, optional `projectId`, and `inheritExecutionWorkspaceFromIssueId` when needed
  - leave the child unassigned
  - post one exact `@CEO` handoff comment on the parent issue
- Pass criteria:
  - the child issue exists
  - `assigneeAgentId` is `null`
  - the parent issue has one exact `@CEO` escalation comment
- Cleanup:
  - revoke the temporary key
  - pause or terminate the temporary agent

Note: invite joins and board-created agents get `tasks:assign` by default, so this drill must remove the grant after agent creation.

## Quiet-Company Fallback Drill

Use a separate non-production company so the quiet window is not polluted by the no-assign drill.

- Company: `openclaw-quiet-test`
- Temporary agent: `OpenClawOps-QuietCheck`
- Create the agent with the normal OpenClaw gateway adapter setup, but keep heartbeat disabled so `liveRuns` stays empty unless you invoke it manually.
- Seed the company with only `todo` issues. Use at least three issues with different priorities and do not create any `blocked` or `in_progress` issues.
- After seeding, leave the company untouched for more than 60 minutes so there is open work, no live runs, and no recent company activity.
- Ask OpenClaw to run the oversight flow against that company and select a quiet-company fallback target.
- First-run pass criteria:
  - the dashboard still shows open work with no live runs and no recent company activity
  - OpenClaw posts exactly one valid `@CEO` nudge
  - the nudge lands on the highest-priority `todo` issue
- Dedupe pass criteria:
  - rerunning the same prompt within 60 minutes with unchanged status and assignee posts no duplicate nudge
  - changing either the issue status or assignee allows one fresh nudge on the next run
- Cleanup:
  - revoke the temporary key
  - pause or terminate the temporary agent

## Technical Contract (Gateway)
`agentDefaultsPayload` minimum:
```json
{
  "url": "ws://127.0.0.1:18789",
  "headers": { "x-openclaw-token": "<gateway-token>" }
}
```

Recommended fields:
```json
{
  "paperclipApiUrl": "http://host.docker.internal:3100",
  "waitTimeoutMs": 120000,
  "sessionKeyStrategy": "issue",
  "role": "operator",
  "scopes": ["operator.admin"]
}
```

Security/pairing defaults:
- `disableDeviceAuth`: default false
- `devicePrivateKeyPem`: generated during join if missing

## Codex Automation Workflow

### 0) Reset and boot
```bash
OPENCLAW_DOCKER_DIR=/tmp/openclaw-docker
if [ -d "$OPENCLAW_DOCKER_DIR" ]; then
  docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" down --remove-orphans || true
fi

docker image rm openclaw:local || true
OPENCLAW_RESET_STATE=1 OPENCLAW_BUILD=1 ./scripts/smoke/openclaw-docker-ui.sh
```

### 1) Start Paperclip
```bash
pnpm dev --bind lan
curl -fsS http://127.0.0.1:3100/api/health
```

### 2) Invite + join + approval
- create invite prompt via `POST /api/companies/:companyId/openclaw/invite-prompt`
- paste prompt to OpenClaw
- approve join request
- assert created agent:
  - `adapterType == openclaw_gateway`
  - token header exists and length >= 16
  - `devicePrivateKeyPem` exists

### 3) Pairing stabilization
- if first run returns `pairing required`, approve pending device in OpenClaw
- rerun task and confirm success
- assert later runs do not require re-pairing for same agent

### 4) Functional E2E assertions
1. Task assigned to OpenClaw is completed and closed.
2. Task asking OpenClaw to send main-webchat message succeeds (message visible in main chat).
3. In `/new` OpenClaw session, OpenClaw can still create a Paperclip task.
4. OpenClaw can read `dashboard`, `inbox-lite`, and `heartbeat-context` before acting.
5. OpenClaw can create a child issue with `parentId`, `goalId`, and `inheritExecutionWorkspaceFromIssueId` when appropriate.
6. OpenClaw can post one valid `@CEO` nudge on stalled work and skip a duplicate nudge within 60 minutes when status and assignee are unchanged.
7. The `no tasks:assign` fallback and quiet-company fallback are validated separately using the two drills above rather than by forcing them in the main smoke path.

## Manual Smoke Checklist
Use [doc/OPENCLAW_ONBOARDING.md](../../../../doc/OPENCLAW_ONBOARDING.md) as the operator runbook.

## Regression Gates
Required before merge:
```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

If full suite is too heavy locally, run at least:
```bash
pnpm --filter @paperclipai/server test:run -- openclaw-gateway
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/ui typecheck
pnpm --filter paperclipai typecheck
```
