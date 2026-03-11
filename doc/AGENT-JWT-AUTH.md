# Agent JWT Authentication

When Paperclip runs an agent via a heartbeat, it checks whether the agent's adapter has opted in to local agent JWT (`supportsLocalAgentJwt: true` in the adapter registry). For adapters that support it, Paperclip creates a short-lived JWT and injects it as `PAPERCLIP_API_KEY` in the agent's environment. The agent uses this token to authenticate API calls back to the Paperclip server, ensuring actions are attributed to the correct agent rather than falling back to the board identity.

Adapters that have not opted in (such as `openclaw_gateway`, which uses its own claimed-API-key authentication) skip JWT injection entirely.

## Supported adapters

| Adapter type | `supportsLocalAgentJwt` |
|-------------|------------------------|
| `claude_local` | true |
| `codex_local` | true |
| `cursor` | true |
| `opencode_local` | true |
| `pi_local` | true |
| `openclaw_gateway` | **false** |

## How it works

1. The heartbeat service calls `createLocalAgentJwt()` with the agent's ID, company ID, adapter type, and run ID.
2. The resulting JWT is injected into the agent's process environment as `PAPERCLIP_API_KEY`.
3. The agent makes API calls with `Authorization: Bearer $PAPERCLIP_API_KEY`.
4. The server's auth middleware (`verifyLocalAgentJwt()`) validates the token and resolves the agent's identity.

## JWT claims

| Claim | Description |
|-------|-------------|
| `sub` | Agent ID |
| `company_id` | Company the agent belongs to |
| `adapter_type` | Adapter type (e.g. `claude_local`, `codex_local`) |
| `run_id` | Current heartbeat run ID |
| `iat` | Issued-at timestamp (seconds) |
| `exp` | Expiration timestamp (seconds) |
| `iss` | Issuer (default: `paperclip`) |
| `aud` | Audience (default: `paperclip-api`) |

## Configuration

Set these environment variables on the Paperclip server:

| Variable | Required | Description |
|----------|----------|-------------|
| `PAPERCLIP_AGENT_JWT_SECRET` | Yes | HMAC-SHA256 signing secret. Must be set for JWT auth to work. |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | No | Token lifetime in seconds (default: 172800 / 48 hours) |
| `PAPERCLIP_AGENT_JWT_ISSUER` | No | JWT issuer claim (default: `paperclip`) |
| `PAPERCLIP_AGENT_JWT_AUDIENCE` | No | JWT audience claim (default: `paperclip-api`) |

If `PAPERCLIP_AGENT_JWT_SECRET` is not set, the server logs a warning and runs agents without JWT auth. In this case, agent API calls may fall back to the board identity.

## OpenClaw gateway agents

The `openclaw_gateway` adapter does **not** participate in the local agent JWT flow (`supportsLocalAgentJwt: false`). Instead, it authenticates using a long-lived API key stored in `~/.openclaw/workspace/paperclip-claimed-api-key.json` during the invite/onboarding flow. No per-run JWT is generated or injected for this adapter.

### Webhook adapter usage

If you are building a custom webhook adapter that calls the Paperclip API, extract the auth token from the execution context and include it in your requests:

```bash
curl -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"body": "Task completed."}'
```

The `X-Paperclip-Run-Id` header is optional but recommended for audit trail purposes.

## Verifying the setup

To confirm JWT auth is working:

1. Check the server logs during a heartbeat run. If you see `"local agent jwt secret missing or invalid"`, set `PAPERCLIP_AGENT_JWT_SECRET`.
2. After a successful run, check the activity log - actions should be attributed to the agent, not "Board".
3. You can decode a JWT to inspect claims (it's a standard HS256 JWT with base64url-encoded segments).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent actions show as "Board" in activity | JWT secret not configured | Set `PAPERCLIP_AGENT_JWT_SECRET` |
| Agent gets 401 on API calls | Token expired or secret mismatch | Check TTL and ensure server/agent use same secret |
| Warning in logs about missing JWT | `PAPERCLIP_AGENT_JWT_SECRET` env var not set | Add it to your server environment |
