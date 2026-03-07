# OpenClaw Gateway Onboarding and Test Plan

## Objective
Define a reliable, repeatable onboarding and E2E test workflow for OpenClaw integration in authenticated/private Paperclip dev mode (`pnpm dev --tailscale-auth`) with a strong UX path for users and a scriptable path for Codex.

This plan covers:
- Current onboarding flow behavior and gaps.
- Recommended UX for `openclaw` (HTTP `sse/webhook`) and `openclaw_gateway` (WebSocket gateway protocol).
- A concrete automation plan for Codex to run cleanup, onboarding, and E2E validation against the `CLA` company.

## Hard Requirements (Testing Contract)
These are mandatory for onboarding and smoke testing:

1. **Stock/clean OpenClaw boot every run**
- Use a fresh, unmodified OpenClaw Docker image path each test cycle.
- Do not rely on persistent/manual in-UI tweaks from prior runs.
- Recreate runtime state each run so results represent first-time user experience.

2. **One-command/prompt setup inside OpenClaw**
- OpenClaw should be bootstrapped by one primary instruction/prompt (copy/paste-able).
- If a kick is needed, allow at most one follow-up message (for example: “how is it going?”).
- Required OpenClaw configuration (transport enablement, auth loading, skill usage) must be embedded in prompt instructions, not manual hidden steps.

3. **Two-lane validation is required**
- Lane A (stock pass lane): unmodified/clean OpenClaw image and config flow. This lane is the release gate.
- Lane B (instrumentation lane): temporary test instrumentation is allowed only to diagnose failures; it cannot be the final passing path.

## External Protocol Constraints
OpenClaw docs to anchor behavior:
- Webhook mode requires `hooks.enabled=true` and exposes `/hooks/wake` + `/hooks/agent`: https://docs.openclaw.ai/automation/webhook
- Gateway protocol is WebSocket challenge/response plus request/event frames: https://docs.openclaw.ai/gateway/protocol
- OpenResponses HTTP endpoint is separate (`gateway.http.endpoints.responses.enabled=true`): https://docs.openclaw.ai/openapi/responses

Implication:
- `webhook` transport should target `/hooks/*` and requires hook server enablement.
- `sse` transport should target `/v1/responses`.
- `openclaw_gateway` should use `ws://` or `wss://` and should not depend on `/v1/responses` or `/hooks/*`.

## Current Implementation Map (What Exists)

### Invite + onboarding pipeline
- Invite create: `POST /api/companies/:companyId/invites`
- Invite onboarding manifest: `GET /api/invites/:token/onboarding`
- Agent-readable text: `GET /api/invites/:token/onboarding.txt`
- Accept join: `POST /api/invites/:token/accept`
- Approve join: `POST /api/companies/:companyId/join-requests/:requestId/approve`
- Claim key: `POST /api/join-requests/:requestId/claim-api-key`

### Adapter state
- `openclaw` adapter supports `sse|webhook` and has remap/fallback behavior for webhook mode.
- `openclaw_gateway` adapter is implemented and working for direct gateway invocation (`connect -> agent -> agent.wait`).

### Existing smoke foundation
- `scripts/smoke/openclaw-docker-ui.sh` builds/starts OpenClaw Docker and polls readiness on `http://127.0.0.1:18789/`.
- Current local OpenClaw smoke config commonly enables `gateway.http.endpoints.responses.enabled=true`, but not hooks (`gateway.hooks`).

## Deep Code Findings (Gaps)

### 1) Onboarding content is still OpenClaw-HTTP specific
`server/src/routes/access.ts` hardcodes onboarding to:
- `recommendedAdapterType: "openclaw"`
- Required `agentDefaultsPayload.headers.x-openclaw-auth`
- HTTP callback URL guidance and `/v1/responses` examples.

There is no adapter-specific onboarding manifest/text for `openclaw_gateway`.

### 2) Company settings snippet is OpenClaw HTTP-first
`ui/src/pages/CompanySettings.tsx` generates one snippet that:
- Assumes OpenClaw HTTP callback setup.
- Instructs enabling `gateway.http.endpoints.responses.enabled=true`.
- Does not provide a dedicated gateway onboarding path.

### 3) Invite landing “agent join” UX is not wired for OpenClaw adapters
`ui/src/pages/InviteLanding.tsx` shows `openclaw` and `openclaw_gateway` as disabled (“Coming soon”) in join UI.

### 4) Join normalization/replay logic only special-cases `adapterType === "openclaw"`
`server/src/routes/access.ts` helper paths (`buildJoinDefaultsPayloadForAccept`, replay, normalization diagnostics) are OpenClaw-HTTP specific.
No equivalent normalization/diagnostics for gateway defaults.

### 5) Webhook confusion is expected in current setup
For `openclaw` + `streamTransport=webhook`:
- Adapter may remap `/v1/responses -> /hooks/agent`.
- If `/hooks/agent` returns `404`, it falls back to `/v1/responses`.

If OpenClaw hooks are disabled, users still see successful `/v1/responses` runs even with webhook selected.

### 6) Auth/testing ergonomics mismatch in tailscale-auth dev mode
- Runtime can be `authenticated/private` via env overrides (`pnpm dev --tailscale-auth`).
- CLI bootstrap/admin helpers read config file (`config.json`), which may still say `local_trusted`.
- Board setup actions require session cookies; CLI `--api-key` cannot replace board session for invite/approval routes.

### 7) Gateway adapter lacks hire-approved callback parity
`openclaw` has `onHireApproved`; `openclaw_gateway` currently does not.
Not a blocker for core routing, but creates inconsistent onboarding feedback behavior.

## UX Intention (Target Experience)

### Product goal
Users should pick one clear onboarding path:
- `Invite OpenClaw (HTTP)` for existing webhook/SSE installs.
- `Invite OpenClaw Gateway` for gateway-native installs.

### UX design requirements
- One-click invite action per mode in `/CLA/company/settings` (or equivalent company settings route).
- Mode-specific generated snippet and mode-specific onboarding text.
- Clear compatibility checks before user copies anything.

### Proposed UX structure
1. Add invite buttons:
- `Invite OpenClaw (SSE/Webhook)`
- `Invite OpenClaw Gateway`

2. For HTTP invite:
- Require transport choice (`sse` or `webhook`).
- Validate endpoint expectations:
  - `sse` with `/v1/responses`.
  - `webhook` with `/hooks/*` and hooks enablement guidance.

3. For Gateway invite:
- Ask only for `ws://`/`wss://` and token source guidance.
- No callback URL/paperclipApiUrl complexity in onboarding.

4. Always show:
- Preflight diagnostics.
- Copy-ready command/snippet.
- Expected next steps (join -> approve -> claim -> skill install).

## Why Gateway Improves Onboarding
Compared to webhook/SSE onboarding:
- Fewer network assumptions: Paperclip dials outbound WebSocket to OpenClaw; avoids callback reachability pitfalls.
- Less transport ambiguity: no `/v1/responses` vs `/hooks/*` fallback confusion.
- Better run observability: gateway event frames stream lifecycle/delta events in one protocol.

Tradeoff:
- Requires stable WS endpoint and gateway token handling.

## Codex-Executable E2E Workflow

## Scope
Run this full flow per test cycle against company `CLA`:
1. Assign task to OpenClaw agent -> agent executes -> task closes.
2. Task asks OpenClaw to send message to user main chat via message tool -> message appears in main chat.
3. OpenClaw in a fresh/new session can still create a Paperclip task.
4. Use one primary OpenClaw bootstrap prompt (plus optional single follow-up ping) to perform setup.

## 0) Cleanup Before Each Run
Use deterministic reset to avoid stale agents/runs/state.

1. OpenClaw Docker cleanup:
```bash
# stop/remove OpenClaw compose services
OPENCLAW_DOCKER_DIR=/tmp/openclaw-docker
if [ -d "$OPENCLAW_DOCKER_DIR" ]; then
  docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" down --remove-orphans || true
fi

# remove old image (as requested)
docker image rm openclaw:local || true
```

2. Recreate OpenClaw cleanly:
```bash
OPENCLAW_RESET_STATE=1 OPENCLAW_BUILD=1 ./scripts/smoke/openclaw-docker-ui.sh
```
This must remain a stock/clean image boot path, with no hidden manual state carried from prior runs.

3. Remove prior CLA OpenClaw agents:
- List `CLA` agents via API.
- Terminate/delete agents with `adapterType in ("openclaw", "openclaw_gateway")` before new onboarding.

4. Reject/clear stale pending join requests for CLA (optional but recommended).

## 1) Start Paperclip in Required Mode
```bash
pnpm dev --tailscale-auth
```
Verify:
```bash
curl -fsS http://127.0.0.1:3100/api/health
# expect deploymentMode=authenticated, deploymentExposure=private
```

## 2) Acquire Board Session for Automation
Board operations (create invite, approve join, terminate agents) require board session cookie.

Short-term practical options:
1. Preferred immediate path: reuse an existing signed-in board browser cookie and export as `PAPERCLIP_COOKIE`.
2. Scripted fallback: sign-up/sign-in via `/api/auth/*`, then use a dedicated admin promotion/bootstrap utility for dev (recommended to add as a small internal script).

Note:
- CLI `--api-key` is for agent auth and is not enough for board-only routes in this flow.

## 3) Resolve CLA Company ID
With board cookie:
```bash
curl -sS -H "Cookie: $PAPERCLIP_COOKIE" http://127.0.0.1:3100/api/companies
```
Pick company where identifier/code is `CLA` and store `CLA_COMPANY_ID`.

## 4) Preflight OpenClaw Endpoint Capability
From host (using current OpenClaw token):
- For HTTP SSE mode: confirm `/v1/responses` behavior.
- For HTTP webhook mode: confirm `/hooks/agent` exists; if 404, hooks are disabled.
- For gateway mode: confirm WS challenge appears from `ws://127.0.0.1:18789`.

Expected in current docker smoke config:
- `/hooks/agent` likely `404` unless hooks explicitly enabled.
- WS gateway protocol works.

## 5) Gateway Join Flow (Primary Path)

1. Create agent-only invite in CLA:
```bash
POST /api/companies/$CLA_COMPANY_ID/invites
{ "allowedJoinTypes": "agent" }
```

2. Submit join request with gateway defaults:
```json
{
  "requestType": "agent",
  "agentName": "OpenClaw Gateway",
  "adapterType": "openclaw_gateway",
  "capabilities": "OpenClaw gateway agent",
  "agentDefaultsPayload": {
    "url": "ws://127.0.0.1:18789",
    "headers": { "x-openclaw-token": "<gateway-token>" },
    "role": "operator",
    "scopes": ["operator.admin"],
    "sessionKeyStrategy": "fixed",
    "sessionKey": "paperclip",
    "waitTimeoutMs": 120000
  }
}
```

3. Approve join request.
4. Claim API key with `claimSecret`.
5. Save claimed token to OpenClaw expected file path (`~/.openclaw/workspace/paperclip-claimed-api-key.json`) and ensure `PAPERCLIP_API_KEY` + `PAPERCLIP_API_URL` are available for OpenClaw skill execution context.
  - Write compatibility JSON keys (`token` and `apiKey`) to avoid runtime parser mismatch.
6. Ensure Paperclip skill is installed for OpenClaw runtime.
7. Send one bootstrap prompt to OpenClaw containing all setup instructions needed for this run (auth file usage, heartbeat procedure, required tools). If needed, send one follow-up nudge only.

## 6) E2E Validation Cases

### Case A: Assigned task execution/closure
1. Create issue in CLA assigned to joined OpenClaw agent.
2. Poll issue + heartbeat runs until terminal.
3. Pass criteria:
- At least one run invoked for that agent/issue.
- Run status `succeeded`.
- Issue reaches `done` (or documented expected terminal state if policy differs).

### Case B: Message tool to main chat
1. Create issue instructing OpenClaw: “send a message to the user’s main chat session in webchat using message tool”.
2. Trigger/poll run completion.
3. Validate output:
- Automated minimum: run log/transcript confirms tool invocation success.
- UX-level validation: message visibly appears in main chat UI.

Current recommendation:
- Keep this checkpoint as manual/assisted until a browser automation harness is added for OpenClaw control UI verification.

### Case C: Fresh session still creates Paperclip task
1. Force fresh-session behavior for test:
- set agent `sessionKeyStrategy` to `run` (or explicitly rotate session key).
2. Create issue asking agent to create a new Paperclip task.
3. Pass criteria:
- New issue appears in CLA with expected title/body.
- Agent succeeds without re-onboarding.

## 7) Observability and Assertions
Use these APIs for deterministic assertions:
- `GET /api/companies/:companyId/heartbeat-runs?agentId=...`
- `GET /api/heartbeat-runs/:runId/events`
- `GET /api/heartbeat-runs/:runId/log`
- `GET /api/issues/:id`
- `GET /api/companies/:companyId/issues?q=...`

Include explicit timeout budgets per poll loop and hard failure reasons in output.

## 8) Automation Artifact
Implemented smoke harness:
- `scripts/smoke/openclaw-gateway-e2e.sh`

Responsibilities:
- OpenClaw docker cleanup/rebuild/start.
- Paperclip health/auth preflight.
- CLA company resolution.
- Old OpenClaw agent cleanup.
- Invite/join/approve/claim orchestration.
- E2E case execution + assertions.
- Final summary with run IDs, issue IDs, agent ID.

## 9) Required Product/Code Changes to Support This Plan Cleanly

### Access/onboarding backend
- Make onboarding manifest/text adapter-aware (`openclaw` vs `openclaw_gateway`).
- Add gateway-specific required fields and examples.
- Add gateway-specific diagnostics (WS URL/token/role/scopes/device-auth hints).

### Company settings UX
- Replace single generic snippet with mode-specific invite actions.
- Add “Invite OpenClaw Gateway” path with concise copy/paste onboarding.

### Invite landing UX
- Enable OpenClaw adapter options when invite allows agent join.
- Allow `agentDefaultsPayload` entry for advanced joins where needed.

### Adapter parity
- Consider `onHireApproved` support for `openclaw_gateway` for consistency.

### Test coverage
- Add integration tests for adapter-aware onboarding manifest generation.
- Add route tests for gateway join/approve/claim path.
- Add smoke test target for gateway E2E flow.

## 10) Execution Order
1. Implement onboarding manifest/text split by adapter mode.
2. Add company settings invite UX split (HTTP vs Gateway).
3. Add gateway E2E smoke script.
4. Run full CLA workflow in authenticated/private mode.
5. Iterate on message-tool verification automation.

## Acceptance Criteria
- No webhook-mode ambiguity: webhook path does not silently appear as SSE success without explicit compatibility signal.
- Gateway onboarding is first-class and copy/pasteable from company settings.
- Codex can run end-to-end onboarding and validation against CLA with repeatable cleanup.
- All three validation cases are documented with pass/fail criteria and reproducible evidence paths.
