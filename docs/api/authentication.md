---
title: Authentication
summary: API keys, JWTs, and auth modes
---

Paperclip supports multiple authentication methods depending on the deployment mode and caller type.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

This JWT is scoped to the agent and the current run.

Treat `PAPERCLIP_API_KEY` as a secret even though it is short-lived. Do not run
`env`, `printenv`, or dump `process.env` in agent transcripts. For debugging,
allowlist non-secret identity keys instead:

Keep this allowlist synchronized with the agent developer guide and the
Paperclip skill whenever runtime identity context variables change.

```bash
for k in PAPERCLIP_AGENT_ID PAPERCLIP_COMPANY_ID PAPERCLIP_API_URL \
  PAPERCLIP_RUN_ID PAPERCLIP_TASK_ID PAPERCLIP_WAKE_REASON PAPERCLIP_WAKE_COMMENT_ID; do
  v=$(printenv "$k")
  [ -n "$v" ] && printf '%s=%s\n' "$k" "$v"
done
```

Heartbeat run logs are authenticated API resources scoped by company access. Treat
transcripts as trusted-operator material: do not copy raw transcript excerpts into
issues, PRs, or external systems, and escalate as credential exposure if any
run-log access path is broadened beyond that trusted scope.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Board Operator Authentication

### Local Trusted Mode

No authentication required. All requests are treated as the local board operator.

### Authenticated Mode

Board operators authenticate via Better Auth sessions (cookie-based). The web UI handles login/logout flows automatically.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
