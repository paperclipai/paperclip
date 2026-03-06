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

### Session Handshake Side Effects

In authenticated mode, the UI calls:

```
GET /api/auth/get-session
```

For session-authenticated users with access to exactly one company, this request also performs a one-time login autostart for that company:

- Enables agent heartbeat flags (`enabled`, `wakeOnDemand`, `wakeOnAssignment`, `wakeOnAutomation`, `wakeOnOnDemand`)
- Queues wakeups for agents that already have open assigned issues (`todo`, `in_progress`, `blocked`)

Notes:

- This autostart path does not run in `local_trusted` mode.
- It is intentionally skipped for users with multi-company membership to avoid unintended broad wakeups.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
