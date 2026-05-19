# Her Workdesk PWA Design

**Date:** 2026-05-16

**Status:** Approved for implementation planning

**Working name:** Her Workdesk PWA

**Goal:** Build a mobile-first PWA for working with 헤르 and 페퍼 from a phone, centered on requesting work through an in-app lightweight chat and checking execution status without forcing the user into the full Paperclip board UI.

## 1. Product Positioning

Her Workdesk PWA is a personal mobile command surface, not a replacement for Telegram, Hermes, or Paperclip.

- **헤르/Hermes:** user-facing conversation, routing, immediate execution, final reporting.
- **페퍼/Paperclip:** back-office execution organization, issue state, agent runs, evidence, usage/cost visibility.
- **Her Workdesk PWA:** mobile front door for initiating requests, reading status, and reviewing results.

The MVP deliberately avoids recreating a full mobile kanban board or a full custom messenger. It adds a minimal in-app chat entry point while preserving Telegram as an operational fallback and notification channel.

## 2. Recommended Approach

Use an independent mobile-first PWA with a small mobile API adapter.

Rejected alternatives:

- **Only make the existing Paperclip UI responsive:** fast to reuse, but weak for the 헤르-first request flow and risks compressing a complex operator board into an unusable phone interface.
- **Build a full native mobile console first:** cleaner long-term, but too much initial surface area: native build chain, push, auth, direct chat, issue operations, and API stability all at once.

Recommended MVP:

- PWA installable from the phone browser.
- In-app lightweight chat for text requests to 헤르.
- Telegram link/fallback remains visible.
- 페퍼 status is shown as readable mobile cards/lists.
- Mobile API shields the frontend from Paperclip internal API churn.

## 3. Architecture

```text
Mobile Browser / PWA
        |
        | session cookie / mobile DTOs
        v
Mobile API Adapter
        |---------------------> Hermes/Telegram delivery path
        |                         - send user message
        |                         - poll or receive assistant response
        |
        |---------------------> Paperclip REST API
                                  - issues
                                  - agents
                                  - health
                                  - reports/summary where available
```

### 3.1 PWA Frontend

Responsibilities:

- Provide high-readability mobile UI.
- Manage login/session state.
- Render home summary cards, chat, work status, agent status, and reports.
- Show clear failure states and retry actions.

Non-responsibilities:

- Store service secrets.
- Call internal Paperclip endpoints directly.
- Implement complex issue editing or decomposition in MVP.

### 3.2 Mobile API Adapter

Responsibilities:

- Expose a stable mobile-focused contract.
- Aggregate Paperclip data into concise DTOs.
- Relay text chat messages to the existing 헤르/Telegram delivery path.
- Persist or expose chat timeline state for the PWA.
- Enforce authentication and protect upstream tokens.

Initial endpoints:

- `POST /api/mobile/auth/login`
- `POST /api/mobile/auth/logout`
- `GET /api/mobile/summary`
- `GET /api/mobile/issues?status=...`
- `GET /api/mobile/agents`
- `GET /api/mobile/reports`
- `GET /api/mobile/chat/messages`
- `POST /api/mobile/chat/messages`
- `POST /api/mobile/chat/messages/:id/retry`

### 3.3 Paperclip Integration

The adapter reads from the local Paperclip API, starting with:

- `GET /api/health`
- `GET /api/companies`
- `GET /api/companies/{companyId}/issues`
- `GET /api/companies/{companyId}/agents`
- `GET /api/issues/{issueId}` where a detail view needs it
- `GET /api/issues/{issueId}/comments` where a report/detail needs it
- `GET /api/issues/{issueId}/heartbeat-context` where blocked/error cause is needed

The PWA presents role, evidence, remaining risk, and next action when data is available.

## 4. MVP Screens

### 4.1 Home

Content:

- Header: `헤르 워크데스크`
- Primary CTA: `헤르에게 작업 요청하기`
- Secondary CTA: `Telegram에서 열기`
- Status cards:
  - 진행 중
  - 검토 필요
  - 완료
  - 차단됨
- Latest completion report preview
- 페퍼 health indicator

Design rule: large text, clear hierarchy, obvious meaning over decorative visuals.

### 4.2 헤르 Chat

MVP behavior:

- User types a text request inside the PWA.
- Mobile API records the outgoing message.
- Mobile API forwards it through the existing 헤르/Telegram delivery path.
- Response is shown in the PWA timeline when available.
- Telegram remains as a fallback/mirror path.

Message states:

- `sending`
- `sent`
- `delivered_to_hermes`
- `response_available`
- `failed`

MVP exclusions:

- File upload
- Voice input
- Image input
- Multi-user rooms
- Full replacement of Telegram DM behavior

### 4.3 Work Status

Content:

- Mobile list of Paperclip issues.
- Filters: all, running, review-needed, blocked, done.
- Each row/card shows:
  - title
  - status
  - priority where available
  - assignee / responsible role
  - last update
  - blocker or risk summary where available

MVP is read-first. Direct issue editing is out of scope unless needed for a narrow retry/continue action later.

### 4.4 Agent Status

Content:

- Agent cards: CEO, PM, Engineer, QA, Researcher where present.
- Status: idle/running/error/blocked.
- Last run or last activity when available.
- Usage/cost summary where heartbeat/cost data is available.

### 4.5 Reports

Content:

- List of recent completion reports/summaries.
- Detail view optimized for mobile reading.
- Responsible party and role are visible in reports.
- `이 대화 이어가기` opens the chat screen with context.

## 5. Security Model

MVP security is single-user and local/private-network oriented.

- `MOBILE_APP_TOKEN` is configured server-side.
- User logs in through the PWA; server sets an HTTP-only session cookie.
- Upstream tokens and secrets stay server-side only:
  - Telegram bot token
  - Hermes config/secrets
  - Paperclip API keys or local trust assumptions
- Do not expose the PWA directly to the public internet without an additional access layer such as Tailscale, Cloudflare Access, VPN, or equivalent HTTPS + identity protection.

Known limitation:

- A single-token login is acceptable for a personal MVP, not for multi-user or internet-facing production.

## 6. Error Handling

Chat failures:

- Show failed message state.
- Preserve original text.
- Provide retry.
- Do not silently drop requests.

Paperclip API failures:

- Show last successful summary if cached.
- Show a visible `상태 갱신 실패` banner.
- Avoid raw JSON dumps in the UI.

Blocked/error agents:

- Display concrete cause and next action when available.
- Use text-first risk communication, not vague red decoration.

Authentication failures:

- Redirect to login.
- Do not leak whether upstream tokens exist.

## 7. Testing Strategy

### API Unit Tests

- Auth token validation and session behavior.
- Summary DTO mapping from Paperclip API responses.
- Issue status normalization.
- Agent status normalization.
- Chat message lifecycle and retry behavior.

### UI Tests

- Home summary renders with normal, empty, and failed API states.
- Chat can submit a message and show sending/sent/failed states.
- Work status filters render correctly.
- Agent status cards handle idle/running/error/blocked.

### Manual Verification

- Open PWA on desktop browser.
- Open PWA from phone browser on the same accessible network.
- Install to home screen where supported.
- Log in with the mobile token.
- Send a text request to 헤르 from the app.
- Confirm the response appears in the app timeline.
- Confirm Telegram fallback/link remains usable.
- Confirm 페퍼 health, issue summary, and agent status are visible.

## 8. Scope Boundaries

In scope for MVP:

- Mobile-first PWA shell.
- Minimal authenticated session.
- In-app text chat relay to 헤르.
- Read-only 페퍼 status/agent/report views.
- Clear error and retry states.

Out of scope for MVP:

- Native iOS/Android app build.
- Native push notifications.
- Multi-user authorization model.
- Full Telegram replacement.
- Complex Paperclip issue editing.
- File, image, or voice messages.
- Public internet exposure without extra access-control layer.

## 9. Acceptance Criteria

The MVP is acceptable when:

1. A phone can open and install the PWA.
2. The user can authenticate with a configured mobile token.
3. The user can send a text request to 헤르 from inside the PWA.
4. The PWA displays the chat timeline including response state.
5. The PWA displays 페퍼 health, issue summary, and agent status.
6. Errors are visible and retryable where appropriate.
7. Secrets are not exposed to the frontend bundle.
8. Verification steps are documented and runnable.

## 10. Implementation Notes

Recommended repository placement:

- If implemented inside Paperclip: add a small mobile route/module and PWA frontend under the existing app structure only if it does not pollute the main board UI.
- If implemented as a sidecar: create a separate `her-workdesk` app that calls Paperclip and Hermes/Telegram locally.

Preferred MVP choice: sidecar first unless deeper Paperclip UI integration proves simpler during implementation planning. The sidecar approach reduces regression risk against the existing Paperclip board.

## 11. Open Questions Resolved for MVP

- Platform: PWA first, native wrapper later.
- Primary use case: request work from 헤르.
- Chat scope: minimal in-app text chat, relayed through existing 헤르/Telegram path.
- Telegram: retained as fallback/mirror path.
- 페퍼 role: status/evidence/read-only control plane view for MVP.
