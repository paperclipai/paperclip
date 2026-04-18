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

### Board API Keys (for CLI and orchestration)

Board users can mint long-lived API tokens to drive board-scoped endpoints (`/api/agents/:id/pause`, `/resume`, `/terminate`, budget updates, etc.) without a browser session. Agent tokens cannot reach these endpoints — board-only routes call `assertBoard()` which rejects `actor.type === "agent"`.

**Obtain a token with the CLI:**

```sh
pnpm paperclipai auth login
```

This creates a challenge on the server, opens your browser to the approval page, and on approval stores a `pcp_*` token in `~/.paperclip/auth.json` (permissions `0600`, keyed by API base). Subsequent CLI calls pick it up automatically.

**Use a token directly:**

```
Authorization: Bearer <board-api-token>
```

Activity-log entries produced with a board API key record `actorType: "user"` and `actorId = <user that minted the key>`, so audit trails remain attributable to a human operator.

**Revoke / inspect:**

```sh
pnpm paperclipai auth logout    # revokes current key and removes local credential
pnpm paperclipai auth whoami    # shows user, instance-admin flag, accessible companies
```

Or `POST /api/cli-auth/revoke-current` with the key in the `Authorization` header.

#### When to use which

| Need | Use |
|------|-----|
| Agent managing its own issues, comments, cost reporting | Agent JWT (`PAPERCLIP_API_KEY` from heartbeat) |
| Agent operating long-lived outside a heartbeat | Agent API key (`POST /api/agents/:id/keys`) |
| Operator scripts calling board-only endpoints | Board API key via `paperclipai auth login` |
| Interactive board user | Web UI session |

Agents — including a Coordinator-style orchestrator — **cannot** hold a board API key. Self-service lifecycle control for agents is limited to the budget-paused self-resume path documented in [Managing Agents](../guides/board-operator/managing-agents); anything broader (e.g., an orchestrator resuming a peer) requires a human-owned board token.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
