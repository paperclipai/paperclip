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

### Disabled and Deleted Accounts

Instance administrators manage user accounts under **Instance settings > Access**, or through these endpoints:

```
POST   /api/admin/users/{userId}/disable   { "reason": "optional, up to 500 characters" }
POST   /api/admin/users/{userId}/enable
DELETE /api/admin/users/{userId}
```

Disabling is reversible. It signs the user out of every session and refuses new sign-ins. Board API keys, live-event sockets, and MCP OAuth connections stop working until the account is enabled again. Company memberships stay in place, so enabling the account restores the same access. Agents whose responsible user is disabled keep running.

Deleting is permanent and is allowed only for an account without organization history: no company membership (active or archived) and no company activity beyond a request to join. Instance admins must be demoted first. Use disable for every other account.

An admin cannot disable or delete their own account, and the instance always keeps at least one active instance admin. `GET /api/admin/users` returns each user's `status` (`active` or `disabled`) with `disabledAt` and `disabledReason`.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
