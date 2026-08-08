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

Long-lived API keys can be created by a board operator for agents that need
persistent access:

```
POST /api/agents/{agentId}/keys
```

The key is hashed at rest and the plaintext value is returned once. Store that
one-time value only in the intended credential vault or deployment secret.
Never paste it into Paperclip issues, comments, documentation, logs,
screenshots, or test fixtures.

A Paperclip agent API key is a Paperclip control-plane credential, not a model
provider credential. Creating one does not require or create an OpenAI API key,
and it does not replace a `codex_local` agent's existing OAuth/subscription
login.

#### Key scopes

The creation body accepts a `scope` object:

- `{"kind":"standard"}` preserves normal company-and-agent authorization.
- `{"kind":"task_bridge", ...}` is for a deterministic external task adapter.
- `{"kind":"skill_test","issueId":"..."}` is restricted to one skill-test issue.

A task-bridge key must include at least one project or parent-issue boundary:

```json
{
  "name": "content-task-bridge",
  "scope": {
    "kind": "task_bridge",
    "projectId": "<project-uuid>",
    "parentIssueId": "<optional-parent-issue-uuid>",
    "allowedAssigneeAgentIds": ["<specialist-agent-uuid>"]
  }
}
```

Singular `projectId` and `parentIssueId` fields can be replaced or supplemented
with `projectIds` and `parentIssueIds` arrays, up to 50 entries each. The
optional `allowedAssigneeAgentIds` array also supports up to 50 entries. The
bridge actor can assign work to itself; every other assignee must be explicitly
allowed.

At creation, Paperclip rejects projects, issues, and assignees that do not
belong to the key agent's company. Pending-approval and terminated agents
cannot be selected as allowed assignees. When project and parent-issue
boundaries are both configured, every scoped parent must belong to one of the
scoped projects. A parent with no project cannot be combined with a project
boundary. Paperclip rejects an unassigned or contradictory parent before
minting the token.

#### Task-bridge enforcement

For a task-bridge bearer key, Paperclip:

- requires issue creation to remain inside every supplied project and/or
  parent boundary;
- stamps bridge-created issues with `originKind: "task_bridge"` and the key ID
  as `originId`;
- allows issue reads, comments, and mutations only when the issue is bridge
  owned (assigned to the bridge actor or created by that key) and still inside
  the persisted boundary;
- mediates issue subresources such as comments, annotations, attachments,
  recovery actions, and accepted plan decompositions through the same issue
  read/write decision;
- reauthorizes project or parent moves against the destination, including
  workflow-controlled assignment transitions; and
- never upgrades the bearer credential to board authority in
  `local_trusted` mode.

Paperclip issue completion or comments still represent agent work only. They do
not approve or complete external CRM/business state.

#### Recovery and compatibility

Scopes are immutable. Revoke a key and create a replacement when its project,
parent boundary, or allowed-assignee set must change. A moved issue that no
longer fits the persisted scope fails closed with `403`; reconcile the issue or
use a correctly scoped replacement key instead of widening authorization.

Legacy database rows with `scope_config = NULL` remain standard agent keys. A
non-null stored scope that no longer matches the current schema fails
authentication with `401` in every deployment mode; it is never silently
treated as a standard or board credential. Revoke malformed keys and mint a
replacement before any rollback that removes or rewrites scoped-key data.

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
