# Paperclip Operational Audit 2026 — Sprint 4
## 10B MCP CLI AND API SURFACES

**Evidence date:** 2026-07-15  
**Scope:** MCP tools, CLI commands, HTTP API routes, webhooks, agent API keys, run identity, board/user auth, company scoping, and which surfaces can safely perform which operations.

---

## 1. MCP Tools

### 1.1 Documented MCP interface
**File:** `doc/TASKS-mcp.md` defines the MCP task management interface.

Available operations:
- **Issues:** `list_issues`, `get_issue`, `create_issue`, `update_issue`, `archive_issue`, `list_my_issues`
- **Workflow States:** `list_workflow_states`, `get_workflow_state`
- **Teams:** `list_teams`, `get_team`
- **Projects:** `list_projects`, `get_project`, `create_project`, `update_project`, `archive_project`
- **Milestones:** `list_milestones`, `get_milestone`, `create_milestone`, `update_milestone`
- **Labels:** `list_labels`, `get_label`, `create_label`, `update_label`
- **Issue Relations:** `list_issue_relations`, `create_issue_relation`, `delete_issue_relation`
- **Comments:** `list_comments`, `create_comment`, `update_comment`, `resolve_comment`
- **Initiatives:** `list_initiatives`, `get_initiative`, `create_initiative`, `update_initiative`, `archive_initiative`

**Total: 35 operations**

### 1.2 MCP implementation evidence
No direct MCP server implementation was inspected in this audit. The `doc/TASKS-mcp.md` is a specification document. The actual MCP server (if implemented) may be in a separate package or behind an integration flag.

**Confidence: MEDIUM** — specification exists; runtime implementation not verified.

---

## 2. CLI Commands

### 2.1 Plugin commands
**File:** `cli/src/commands/client/plugin.ts`

| Command | Description |
|---------|-------------|
| `plugin list [--status]` | List installed plugins |
| `plugin install <package> [--local] [--version]` | Install from npm or local path |
| `plugin uninstall <pluginKey> [--force]` | Uninstall (soft or hard delete) |
| `plugin enable <pluginKey>` | Enable a disabled plugin |
| `plugin disable <pluginKey>` | Disable a running plugin |
| `plugin inspect <pluginKey>` | Show plugin details |
| `plugin examples` | List bundled example plugins |

### 2.2 Routine commands
**File:** `cli/src/commands/routines.ts`

| Command | Description |
|---------|-------------|
| `routines disable-all [--company-id] [--config]` | Pause all non-archived routines for a company |

### 2.3 Other CLI commands
The CLI likely has more commands (agents, issues, etc.) but the audit focused on plugin and routine surfaces.

**Confidence: HIGH** — for inspected files; other commands not traced.

---

## 3. HTTP API Routes

### 3.1 Core API routes (board + agent access)
All routes under `/api/*`. Key route files inspected:

**File:** `server/src/routes/index.ts`
```typescript
export { healthRoutes } from "./health.js";
export { companyRoutes } from "./companies.js";
export { companySkillRoutes } from "./company-skills.js";
export { agentRoutes } from "./agents.js";
export { projectRoutes } from "./projects.js";
export { issueRoutes } from "./issues.js";
export { issueTreeControlRoutes } from "./issue-tree-control.js";
export { routineRoutes } from "./routines.js";
export { goalRoutes } from "./goals.js";
export { approvalRoutes } from "./approvals.js";
export { secretRoutes } from "./secrets.js";
export { costRoutes } from "./costs.js";
export { activityRoutes } from "./activity.js";
export { dashboardRoutes } from "./dashboard.js";
export { llmRoutes } from "./llms.js";
export { accessRoutes } from "./access.js";
export { instanceSettingsRoutes } from "./instance-settings.js";
// ... plus plugin routes and adapter routes
```

### 3.2 Plugin routes
**File:** `server/src/routes/plugins.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | List plugins |
| GET | `/api/plugins/examples` | List example plugins |
| GET | `/api/plugins/ui-contributions` | UI slot metadata |
| POST | `/api/plugins/install` | Install plugin (instance admin) |
| DELETE | `/api/plugins/:pluginId` | Uninstall |
| POST | `/api/plugins/:pluginId/enable` | Enable |
| POST | `/api/plugins/:pluginId/disable` | Disable |
| GET | `/api/plugins/:pluginId/health` | Health check |
| POST | `/api/plugins/:pluginId/upgrade` | Upgrade |
| GET | `/api/plugins/:pluginId/jobs` | List jobs |
| GET | `/api/plugins/:pluginId/jobs/:jobId/runs` | List job runs |
| POST | `/api/plugins/:pluginId/jobs/:jobId/trigger` | Manual job trigger |
| POST | `/api/plugins/:pluginId/webhooks/:endpointKey` | Webhook ingress |
| GET | `/api/plugins/tools` | List plugin tools |
| POST | `/api/plugins/tools/execute` | Execute plugin tool |
| GET | `/api/plugins/:pluginId/config` | Get config |
| POST | `/api/plugins/:pluginId/config` | Save config |
| POST | `/api/plugins/:pluginId/bridge/data` | Bridge getData |
| POST | `/api/plugins/:pluginId/bridge/action` | Bridge performAction |
| GET | `/api/plugins/:pluginId/bridge/stream/:channel` | SSE stream |
| POST | `/api/plugins/:pluginId/data/:key` | REST getData |
| POST | `/api/plugins/:pluginId/actions/:key` | REST performAction |
| USE | `/api/plugins/:pluginId/api/*` | Scoped plugin API routes |

### 3.3 Adapter routes
**File:** `server/src/routes/adapters.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/adapters` | List adapters |
| POST | `/api/adapters/install` | Install external adapter |
| PATCH | `/api/adapters/:type` | Enable/disable |
| PATCH | `/api/adapters/:type/override` | Pause/resume builtin override |
| DELETE | `/api/adapters/:type` | Unregister |
| POST | `/api/adapters/:type/reload` | Hot reload |
| POST | `/api/adapters/:type/reinstall` | Reinstall from npm |
| GET | `/api/adapters/:type/config-schema` | Config schema |
| GET | `/api/adapters/:type/ui-parser.js` | UI parser source |

### 3.4 Routine routes
**File:** `server/src/routes/routines.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies/:companyId/routines` | List routines |
| POST | `/api/companies/:companyId/routines` | Create routine |
| GET | `/api/routines/:id` | Get routine detail |
| PATCH | `/api/routines/:id` | Update routine |
| GET | `/api/routines/:id/runs` | List runs |
| POST | `/api/routines/:id/triggers` | Create trigger |
| PATCH | `/api/routine-triggers/:id` | Update trigger |
| DELETE | `/api/routine-triggers/:id` | Delete trigger |
| POST | `/api/routine-triggers/:id/rotate-secret` | Rotate secret |
| POST | `/api/routines/:id/run` | Manual run |
| POST | `/api/routine-triggers/public/:publicId/fire` | Webhook trigger |

### 3.5 Approval routes
**File:** `server/src/routes/approvals.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies/:companyId/approvals` | List approvals |
| GET | `/api/approvals/:id` | Get approval |
| POST | `/api/companies/:companyId/approvals` | Create approval |
| GET | `/api/approvals/:id/issues` | List linked issues |
| POST | `/api/approvals/:id/approve` | Approve (board only) |
| POST | `/api/approvals/:id/reject` | Reject (board only) |
| POST | `/api/approvals/:id/request-revision` | Request revision (board only) |
| POST | `/api/approvals/:id/resubmit` | Resubmit |
| GET | `/api/approvals/:id/comments` | List comments |
| POST | `/api/approvals/:id/comments` | Add comment |

### 3.6 Issue routes (subset)
**File:** `server/src/routes/issues.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies/:companyId/issues` | List issues |
| POST | `/api/companies/:companyId/issues` | Create issue |
| GET | `/api/issues/:id` | Get issue |
| PATCH | `/api/issues/:id` | Update issue |
| POST | `/api/issues/:id/checkout` | Checkout issue |
| POST | `/api/issues/:id/comments` | Add comment |
| POST | `/api/issues/:id/attachments` | Upload attachment |
| POST | `/api/issues/:id/documents` | Upsert document |
| POST | `/api/issues/:id/child-issues` | Create child issue |
| POST | `/api/issues/:id/feedback-votes` | Vote on feedback |

**Confidence: HIGH** — for inspected routes; full API surface not exhaustively mapped.

---

## 4. Webhooks

### 4.1 Plugin webhooks
- Ingested at `POST /api/plugins/:pluginId/webhooks/:endpointKey`
- Plugin must declare `webhooks` in manifest with `webhooks.receive` capability.
- Delivery logged in `plugin_webhook_deliveries` table.

### 4.2 Routine webhooks
- Ingested at `POST /api/routine-triggers/public/:publicId/fire`
- No plugin required; routine trigger defines auth mode.

**Confidence: HIGH**

---

## 5. Agent API Keys

### 5.1 Authentication
- Agents authenticate with bearer tokens via `Authorization: Bearer {key}`.
- Keys are stored in `agent_api_keys` table, hashed at rest.
- Each key belongs to exactly one company.

### 5.2 Scoping
- `assertCompanyAccess(req, companyId)` enforces: agents cannot access other companies.
- `req.actor.type === "agent"` → `req.actor.companyId` is checked against the target company.

### 5.3 Run identity
- Agents run with `runId` in the actor context.
- `req.actor.runId` is available for checkout ownership assertions.
- Short-lived run identity: each heartbeat run gets a unique `runId` (UUID).

**Key symbols:**
- `server/src/routes/authz.ts::assertCompanyAccess()`
- `packages/db/src/schema/agent_api_keys.ts`
- `packages/db/src/schema/heartbeat_runs.ts`

**Confidence: HIGH**

---

## 6. Board/User Authentication

### 6.1 Auth modes
- Board access: web UI login; treated as full-control operator context.
- `assertBoard(req)` requires `req.actor.type === "board"`.
- Board users can access any company they belong to.
- Instance admins (`req.actor.isInstanceAdmin`) have unrestricted access.

### 6.2 Permission checks
- `viewer` membership role → read-only for mutations.
- `tasks:assign` permission required for routine creation/assignment.
- Instance admin required for plugin install, adapter install, instance settings.

**Key symbols:**
- `server/src/routes/authz.ts`
- `server/src/routes/routines.ts::assertBoardCanAssignTasks()`

**Confidence: HIGH**

---

## 7. Company Scoping

Every domain entity is company-scoped:
- `issues.company_id`
- `routines.company_id`
- `projects.company_id`
- `agents.company_id`
- `activity_log.company_id`
- `company_secrets.company_id`

API routes validate company access via `assertCompanyAccess(req, companyId)`.

**Confidence: HIGH**

---

## 8. Safe External Surfaces Matrix

| Operation | Board API | Agent API | Plugin | Routine Webhook | Plugin Webhook | External Service + API |
|-----------|-----------|-----------|--------|-----------------|----------------|----------------------|
| Create issues | ✅ | ✅ | ✅ (cap) | ✅ (via routine) | ❌ | ✅ |
| Add comments | ✅ | ✅ | ✅ (cap) | ❌ | ❌ | ✅ |
| Create documents | ✅ | ✅ | ? | ❌ | ❌ | ✅ |
| Upload attachments | ✅ | ? | ? | ❌ | ❌ | ✅ |
| Request approvals | ✅ | ? | ❌ | ❌ | ❌ | ✅ |
| Inspect approvals | ✅ | ? | ? | ❌ | ❌ | ✅ |
| Wake agents | ✅ | ? | ✅ (cap) | ✅ (via routine) | ❌ | ✅ |
| Create routines | ✅ | ? | ❌ | ❌ | ❌ | ✅ |
| Inspect activity | ✅ | ? | ✅ (cap) | ❌ | ❌ | ✅ |
| Record work products | ✅ | ? | ? | ❌ | ❌ | ✅ |

### Legend
- ✅ = Supported and verified
- ? = Likely supported but not directly verified in this audit
- ❌ = Not supported

### Notes
- **Plugin creating issues:** Requires `issues.create` capability.
- **Plugin adding comments:** Requires `issue.comments.create` capability.
- **Plugin waking agents:** Requires `issues.wakeup` capability.
- **Plugin creating approvals:** NOT exposed in `OPERATION_CAPABILITIES`.
- **Routine webhooks:** Can trigger routines that create issues and wake agents, but cannot directly create comments/documents.
- **External service using API:** Any operation the API supports can be done by an authenticated external service.

**Confidence: HIGH** for verified cells; MEDIUM for `?` cells.

---

## 9. Architectural Contradictions

### 9.1 The MCP specification (`doc/TASKS-mcp.md`) defines 35 operations, but no MCP server implementation was found in the codebase
The document is a rich specification with parameter tables, return shapes, and side effects, but searching for actual MCP server code (e.g., `mcp-server`, `CreateServer`, `@modelcontextprotocol`) returned no results in the server or CLI packages inspected.

**Severity:** Medium — the specification exists but may not be wired to a running MCP server. This could mean:
- MCP is planned but not implemented
- MCP server lives in a separate package not inspected
- MCP is implemented via a generic JSON-RPC proxy not found in this audit

### 9.2 Agent API keys are scoped to companies, but plugin API routes use `companyResolution` that defaults to `req.actor.companyId` for agents, which may not match the plugin's intended company
A plugin-declared API route with `auth: "agent"` and no explicit `companyResolution` will use `req.actor.companyId`. If the agent making the request belongs to company A but the plugin expects to operate on company B (e.g., a cross-company sync plugin), the route will incorrectly scope to company A.

**Severity:** Low — plugins should declare explicit `companyResolution` for multi-company scenarios.

### 9.3 Webhooks (both plugin and routine) do not write to the activity log on authentication failure
Failed webhook deliveries (401, 403) are logged at the server level but do not create `activity_log` entries. This means a denial-of-service attempt via fake webhooks is invisible in the company activity stream.

**Severity:** Low — server logs capture failures; activity log is for successful domain mutations.

### 9.4 The `plugin.tools.execute` endpoint validates `runContext` scope (agent, run, project all belong to same company) but does not verify that the agent is the one currently assigned to an in-progress issue
A plugin tool could be called with a valid `runContext` but the run might not have checkout ownership of the issue the tool is manipulating. The tool execution path does not call `assertCheckoutOwner`.

**Severity:** Medium — plugin tools operate outside the checkout model. This is by design (tools are meant to be auxiliary), but it means a plugin tool could modify an issue while another agent has it checked out.

---

*No other contradictions identified from current evidence.*
