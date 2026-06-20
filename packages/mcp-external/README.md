# @paperclipai/mcp-external

External multi-tenant Paperclip MCP server (streamable-HTTP). Replaces the Python
`paperclip-mcp` fork. Exposes snake_case Paperclip tools and forwards each
request's inbound `Authorization: Bearer pcp_*` to the Paperclip REST API, so the
server acts **as the calling user** (multi-tenant). Falls back to a baked
`PAPERCLIP_API_KEY` only when no inbound bearer is present.

> Status: WAVE 1. Tool surface: `get_agent` + issues/projects/goals CRUD
> (list_issues, get_issue, create_issue, update_issue, checkout_issue,
> release_issue, delete_issue, comment_on_issue, paperclip_search_issues,
> list_projects, get_project, create_project, update_project, list_goals,
> create_goal, update_goal). Remaining tools (agents list / heartbeat,
> approvals, dashboard, cost, activity) land in Wave 2. Not the
> canonical external server until tool parity + cutover complete.

> Known limitation (parity-faithful): `checkout_issue` / `release_issue` mirror
> the Python external server's bodyless `POST`, but the current backend's
> `checkoutIssueSchema` requires `agentId` + `expectedStatuses`, so these `400`
> against current `master` — a **pre-existing bug in the Python external surface**
> (an external user bearer has no agent identity: `GET /agents/me` → 401). Making
> them work needs an external-checkout design decision (which agent does a user
> check out as?), tracked as a cutover follow-up — not a wave-1 port change.

## Run

    PAPERCLIP_API_URL=http://localhost:3100 MCP_HOST=0.0.0.0 MCP_PORT=9011 \
      node dist/http.js
    # POST/GET/DELETE http://<host>:9011/mcp  (Mcp-Session-Id stateful)

## Env

| Var | Required | Notes |
|---|---|---|
| `PAPERCLIP_API_URL` | yes | `/api` appended if absent |
| `PAPERCLIP_API_KEY` | no | baked fallback bearer (stdio / unauthenticated only) |
| `PAPERCLIP_COMPANY_ID` | no | default company for company-scoped tools |
| `MCP_HOST` / `MCP_PORT` | no | default `127.0.0.1:9011` |

## Auth model

Per request: inbound `Authorization` (verbatim) > `Bearer ${PAPERCLIP_API_KEY}` >
error. Mirrors the Python server's `_headers` precedence, minus its baked session-token (Cookie) tier. The bearer is carried
through an `AsyncLocalStorage` (`auth-context.ts`) so concurrent sessions never
cross identities.
