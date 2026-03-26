---
name: paperclip-ctx-auth
description: "Mint and use a local Paperclip agent JWT from inside `ctx_execute` for authenticated API calls in local or Tailscale/private-network dev mode. Use when `ctx_execute` must call the Paperclip API, `PAPERCLIP_API_KEY` is `pcli-local` or otherwise unusable, the server reports `deploymentMode: authenticated`, or direct sandboxed requests return `401 Agent authentication required`."
---

# Paperclip ctx auth

Use this skill when `ctx_execute` needs to call the local Paperclip API in authenticated dev mode.
This is an injected file-backed skill, not a callable tool. In Codex runtimes, Paperclip exposes it by linking the skill directory into the active workspace under `.agents/skills/paperclip-ctx-auth`. Use the helper script from that directory via `import(...)`.

The key point: inside `ctx_execute`, `PAPERCLIP_API_KEY` may be the fallback `pcli-local`. In authenticated mode that fails. Mint a real local agent JWT inside the sandbox instead.

## Quick start

Import the bundled helper from `ctx_execute`:

```javascript
const { paperclipRequest } = await import(
  'file:///absolute/path/to/.agents/skills/paperclip-ctx-auth/scripts/paperclip_request.mjs'
);

const { response, runId, identity } = await paperclipRequest('/agents/me');
const body = await response.json();
console.log(JSON.stringify({ status: response.status, runId, identity, body }, null, 2));
```

If you are working from a worktree, change the absolute prefix but keep the `.agents/skills/paperclip-ctx-auth/...` suffix.

## Workflow

1. Confirm the server is reachable:

```javascript
const res = await fetch('http://localhost:3100/api/health');
console.log(await res.text());
```

2. If the health response shows `deploymentMode: authenticated`, do not rely on `PAPERCLIP_API_KEY=pcli-local`.

3. Import `scripts/paperclip_request.mjs` and call `paperclipRequest('/path')`.

4. If you already know the agent identity, pass it explicitly:

```javascript
const result = await paperclipRequest('/agents/me', {
  identity: {
    agentId: '...',
    companyId: '...',
    adapterType: 'codex_local',
  },
});
```

5. If identity is not provided, the helper resolves it from:
   - `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_ADAPTER_TYPE`, or
   - the local Postgres DB for an active `codex_local` agent

## What the helper does

`scripts/paperclip_request.mjs`:

- reads `PAPERCLIP_AGENT_JWT_SECRET` from the local Paperclip instance env file
- mints the same HS256 JWT shape as `server/src/agent-auth-jwt.ts`
- sets `Authorization: Bearer <jwt>`
- sets `X-Paperclip-Run-Id`
- sends the request to `PAPERCLIP_API_URL` or `http://localhost:3100/api`

## Local assumptions

- The local Paperclip instance env file is at `~/.paperclip/instances/<instance>/.env`
- Default instance is `default`
- Local DB defaults:
  - host `127.0.0.1`
  - port `54329`
  - db `paperclip`
  - user `paperclip`
  - password `paperclip`

These can be overridden by env vars already visible to `ctx_execute`.

## Failure handling

- `401 Agent authentication required`
  Use this skill and mint the JWT inside `ctx_execute`.

- `PAPERCLIP_AGENT_JWT_SECRET missing`
  Check the local Paperclip instance env file and repair the Paperclip setup if needed.

- `No active agent found for adapter_type=codex_local`
  Pass `identity` explicitly or set `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_ADAPTER_TYPE`.

- `404 Not Found`
  Check the API base URL. For local Paperclip it is typically `http://localhost:3100/api`.
