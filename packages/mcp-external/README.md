# @paperclipai/mcp-external

External multi-tenant Paperclip MCP server (streamable-HTTP). Replaces the Python
`paperclip-mcp` fork. Exposes snake_case Paperclip tools and forwards each
request's inbound `Authorization: Bearer pcp_*` to the Paperclip REST API, so the
server acts **as the calling user** (multi-tenant). Falls back to a baked
`PAPERCLIP_API_KEY` only when no inbound bearer is present.

> Status: FOUNDATION ONLY. Tool surface is `get_agent`. Remaining tools land in
> follow-on plans. Do not deploy as the canonical external server until tool
> parity + cutover plans complete.

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
error. Mirrors the Python server's `_headers` precedence. The bearer is carried
through an `AsyncLocalStorage` (`auth-context.ts`) so concurrent sessions never
cross identities.
