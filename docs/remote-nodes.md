# Remote Nodes

Remote nodes allow Paperclip agents to execute on registered external machines instead of the server host. A node is any machine running the `paperclipai node run` daemon — it polls the server for queued runs, executes them locally (via Claude Code or another adapter), and reports results back.

## Architecture

```
Paperclip Server (K8s / Docker)          Remote Node (e.g. Mac, GPU box)
┌────────────────────────────────┐       ┌──────────────────────────────┐
│  Heartbeat service queues run  │       │  paperclipai node run        │
│  remote_node adapter waits     │◄──────│    ├─ POST /heartbeat (30s)  │
│                                │       │    ├─ POST /claim            │
│  POST /nodes/:id/claim → 200  │──────►│    ├─ spawn claude --print   │
│  POST /nodes/:id/runs/log     │◄──────│    ├─ POST /log (streaming)  │
│  POST /nodes/:id/runs/report  │◄──────│    └─ POST /report (done)    │
│                                │       │                              │
│  Waiter resolves → run done    │       │  Claude Code exits           │
└────────────────────────────────┘       └──────────────────────────────┘
```

The runner authenticates with a **node API key** (`pnk_` prefix), polls for work every 5 seconds with a heartbeat every 30 seconds, and spawns the configured local adapter (default: `claude`) for each claimed run.

---

## New Files

### Database

| File | Purpose |
|------|---------|
| `packages/db/src/schema/nodes.ts` | Drizzle ORM schema for the `nodes` table |
| `packages/db/src/schema/node_api_keys.ts` | Drizzle ORM schema for the `node_api_keys` table |
| `packages/db/src/migrations/0026_remote_nodes.sql` | SQL migration: creates both tables and adds `remote_claimed_at` column to `heartbeat_runs` |

#### `nodes` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `company_id` | uuid FK → companies | Owning company |
| `name` | text | Human-readable name, unique per company |
| `status` | text | `online`, `offline`, or `draining` |
| `capabilities` | jsonb | Key-value metadata (e.g. `{"browser": true, "macos": true}`) |
| `last_seen_at` | timestamptz | Updated on each heartbeat |
| `registered_by_actor_type` | text | Who registered it (`user` or `agent`) |
| `registered_by_actor_id` | text | Actor ID |
| `metadata` | jsonb | Arbitrary metadata |
| `created_at` / `updated_at` | timestamptz | Timestamps |

Indexes: `(company_id, status)`, unique `(company_id, name)`.

#### `node_api_keys` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `node_id` | uuid FK → nodes | Associated node |
| `company_id` | uuid FK → companies | Company scope |
| `name` | text | Key name (e.g. "default") |
| `key_hash` | text | SHA-256 hash of the raw key |
| `last_used_at` | timestamptz | Updated on each validated request |
| `revoked_at` | timestamptz | Set when key is revoked |
| `created_at` | timestamptz | Creation time |

Indexes: `(key_hash)`, `(company_id, node_id)`.

#### `heartbeat_runs` addition

| Column | Type | Description |
|--------|------|-------------|
| `remote_claimed_at` | timestamptz | Set when a remote runner claims the run |

---

### Adapter Package: `@paperclipai/adapter-remote-node`

Located at `packages/adapters/remote-node/`. Exports three entry points matching Paperclip's adapter convention:

#### `.` (main) — `src/index.ts`

Exports adapter metadata:
- `type`: `"remote_node"`
- `label`: `"Remote Node"`
- `models`: `[]` (no model list — model is configured on the node)
- `agentConfigurationDoc`: Markdown documentation for the CEO/LLM describing how to configure this adapter

#### `./server` — `src/server/index.ts`

Server-side adapter module:

- **`execute(ctx)`** (`src/server/execute.ts`): Core adapter function. Does NOT spawn a process — instead:
  1. Registers a deferred Promise in `remoteRunWaiters` (keyed by `runId`)
  2. Waits for the remote runner to claim, execute, and report back
  3. The report endpoint resolves the Promise
  4. Returns `AdapterExecutionResult`
  5. Has configurable timeout (default 3600s)

- **`remoteRunWaiters`**: `Map<string, RemoteRunWaiter>` — shared between `execute()` and the report route. Each waiter has `resolve`, `reject`, and `onLog` callbacks.

- **`remoteCompletionEmitter`**: `EventEmitter` — backup notification path. Emits `run.complete` and `run.cancel` events.

- **`testEnvironment(ctx)`** (`src/server/test.ts`): Validates that `nodeId` is set in adapter config.

- **`sessionCodec`**: Claude-local compatible codec that passes through `sessionId`, `cwd`, `workspaceId`, `repoUrl`, `repoRef`.

#### `./ui` — `src/ui/index.ts`

- **`parseRemoteNodeStdoutLine(line, ts)`**: Parses JSON-line log output from remote runs into `TranscriptEntry[]`
- **`buildRemoteNodeConfig(v)`**: Builds `adapterConfig` from the create-agent form values

#### `./cli` — `src/cli/index.ts`

- **`printRemoteNodeStreamEvent(event)`**: Formats remote node log events for CLI display

---

### Server Service: `server/src/services/nodes.ts`

`nodeService(db)` returns:

| Method | Description |
|--------|-------------|
| `create(input)` | Insert new node |
| `list(companyId)` | List nodes for a company |
| `getById(nodeId)` | Get single node |
| `update(nodeId, patch)` | Update name, status, capabilities, metadata |
| `remove(nodeId)` | Delete node + revoke all its API keys |
| `recordHeartbeat(nodeId)` | Set `last_seen_at` = now, `status` = online |
| `isOnline(node)` | Check if node was seen within 90 seconds |
| `createApiKey(input)` | Generate `pnk_<uuid>` key, store SHA-256 hash |
| `validateApiKey(token)` | Hash token, look up, update `last_used_at` |
| `revokeApiKey(keyId)` | Set `revoked_at` |

---

### Server Routes: `server/src/routes/nodes.ts`

Two groups of endpoints:

#### Board-facing CRUD (authenticated via session/board auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/companies/:companyId/nodes` | Register a new node. Auto-creates a default API key. Returns `{ node, apiKey: { id, key } }` |
| `GET` | `/companies/:companyId/nodes` | List all nodes for a company |
| `GET` | `/companies/:companyId/nodes/:nodeId` | Get node details |
| `PATCH` | `/companies/:companyId/nodes/:nodeId` | Update node (name, status, capabilities) |
| `DELETE` | `/companies/:companyId/nodes/:nodeId` | Deregister node |
| `POST` | `/companies/:companyId/nodes/:nodeId/keys` | Create additional API key for a node |

#### Runner-facing endpoints (authenticated via `Bearer <node_api_key>`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/nodes/:nodeId/heartbeat` | Keepalive. Updates `last_seen_at`, sets status `online`. Returns `{ ok, pendingRuns }` |
| `POST` | `/nodes/:nodeId/claim` | Claim the next queued run. Finds agents with `adapter_type = 'remote_node'` whose `adapterConfig.nodeId` matches, picks the oldest unclaimed running run, atomically sets `remote_claimed_at`. Returns run context or `204 No Content` |
| `POST` | `/nodes/:nodeId/runs/:runId/log` | Stream log chunks. Forwards to the waiting `execute()`'s `onLog` callback. Returns `409` if run was cancelled |
| `POST` | `/nodes/:nodeId/runs/:runId/report` | Report run completion. Resolves the `remoteRunWaiter` promise with exit code, usage, session info, etc. |

Authentication: `authenticateNodeRunner(req)` extracts the Bearer token, validates via `nodeService.validateApiKey()`, and checks that the key belongs to the requested node.

---

### CLI Commands: `cli/src/commands/client/node.ts`

Registered as `paperclipai node <subcommand>`.

#### `paperclipai node register <name>`

```
Options:
  -C, --company-id <id>     Company ID (required)
  --capabilities <json>     JSON object of node capabilities
```

Calls `POST /companies/:companyId/nodes`. Prints the node ID, API key (shown only once), and environment variable exports.

#### `paperclipai node list`

```
Options:
  -C, --company-id <id>     Company ID (required)
```

Lists registered nodes with status, capabilities, last seen.

#### `paperclipai node status <nodeId>`

Shows details for a specific node.

#### `paperclipai node run`

The long-running runner daemon. Reads configuration from options or environment variables:

```
Options:
  --node-id <id>        Node ID (or PAPERCLIP_NODE_ID env)
  --api-url <url>       Paperclip API URL (or PAPERCLIP_API_URL env)
  --api-key <key>       Node API key (or PAPERCLIP_NODE_KEY env)
  --max-concurrent <n>  Max concurrent runs (default: 1)
```

Behavior:
1. Sends heartbeat every 30 seconds
2. Polls for claimable runs every 5 seconds
3. When a run is claimed, spawns the configured local adapter (default: `claude`) with `--output-format stream-json --verbose --print <prompt>`
4. Streams stdout/stderr to `POST /nodes/:nodeId/runs/:runId/log`
5. On completion, sends result to `POST /nodes/:nodeId/runs/:runId/report`
6. Graceful shutdown on SIGINT/SIGTERM: finishes active runs, sends offline heartbeat, exits

Environment cleanup: strips all `CLAUDECODE*` and `CLAUDE_CODE_*` env vars from the child process to prevent nested session detection. Uses `stdio: ["ignore", "pipe", "pipe"]` since `--print` mode doesn't need stdin.

Result parsing: reads the last `{"type":"result",...}` line from Claude Code's stream-json output to extract usage, session ID, cost, model, and summary.

---

### UI Components

#### `ui/src/pages/Nodes.tsx`

Node management page at `/nodes`. Shows:
- List of registered nodes with status indicator (green=online, yellow=draining, grey=offline)
- Node name, ID, capabilities
- Relative "last seen" timestamps

#### `ui/src/adapters/remote-node/index.ts`

UI adapter module registration:
- `type`: `"remote_node"`
- `label`: `"Remote Node"`
- `ConfigFields`: React component for agent config form
- `parseStdoutLine`: Log line parser
- `buildConfig`: Config builder for create-agent flow
- `models`: `[]`

#### `ui/src/adapters/remote-node/config-fields.tsx`

Agent configuration form fields:
- **Node ID** (text input): UUID of the target node
- **Local adapter type** (dropdown): claude_local, codex_local, opencode_local, pi_local, cursor
- **Remote CWD** (text input): Working directory on the remote node
- **Timeout** (number input): Max seconds to wait (60–86400, default 3600)

Node ID is shown for both create and edit modes. The other fields are only shown in edit mode.

#### `ui/src/components/Sidebar.tsx`

Added "Nodes" link with `Server` icon under the "Company" section in the sidebar navigation.

---

## Modified Files

### `packages/shared/src/constants.ts`

- Added `"remote_node"` to `AGENT_ADAPTER_TYPES` array
- Added `NODE_STATUSES` constant: `["online", "offline", "draining"]`
- Added live event types: `"node.run.available"`, `"node.run.cancelled"`, `"node.status"`

### `packages/shared/src/index.ts` + `types/index.ts` + `validators/index.ts`

Exported `NODE_STATUSES`, `NodeStatus`, `Node`, `NodeKeyCreated`, and the three Zod validators (`createNodeSchema`, `updateNodeSchema`, `createNodeKeySchema`).

### `packages/db/src/schema/index.ts`

Exported `nodes` and `nodeApiKeys` tables.

### `packages/db/src/schema/heartbeat_runs.ts`

Added `remoteClaimedAt` column definition.

### `server/src/adapters/registry.ts`

Registered `remoteNodeAdapter` in the adapter map with `execute`, `testEnvironment`, `sessionCodec`, and `agentConfigurationDoc`.

### `server/src/app.ts`

Mounted `nodeRoutes(db)` on the API router.

### `server/src/services/heartbeat.ts`

Major additions for remote node support:

1. **`maybeNotifyRemoteNode(run)`**: Called after every run queue/promote. If the agent uses `remote_node` adapter, publishes a `node.run.available` live event so the runner knows to poll.

2. **`isRemoteNodeRun(agentId)`**: Checks if an agent uses `remote_node` adapter.

3. **`shouldReapRemoteRun(run, now)`**: Determines if a remote run should be reaped:
   - If never claimed and older than 10 minutes → reap
   - If claimed but no updates for 10 minutes AND node is offline (>90s since last heartbeat) → reap

4. **`reapOrphanedRuns()`** modified: Before the existing local-process reaping logic, checks if the run is remote. If so, uses `shouldReapRemoteRun()` instead of checking `runningProcesses`.

5. **`cancelRun()`** modified: For remote runs, emits `run.cancel` on `remoteCompletionEmitter` and publishes `node.run.cancelled` live event instead of sending SIGTERM to a local process.

### `server/src/services/index.ts`

Exported `nodeService`.

### `server/package.json` + `ui/package.json`

Added `@paperclipai/adapter-remote-node: "workspace:*"` dependency.

### `ui/src/adapters/registry.ts`

Registered `remoteNodeUIAdapter` in the UI adapter registry.

### `ui/src/App.tsx`

Added `<Route path="nodes" element={<Nodes />} />`.

### `cli/src/index.ts`

Imported and called `registerNodeCommands(program)`.

### `Dockerfile`

Added `COPY packages/adapters/remote-node/package.json packages/adapters/remote-node/` to the deps stage so pnpm can resolve the workspace dependency.

### `server/src/index.ts`

Worked around a pre-existing `initdbFlags` type mismatch in embedded-postgres with a spread cast.

---

## Shared Types

### `Node` (from `packages/shared/src/types/node.ts`)

```typescript
interface Node {
  id: string;
  companyId: string;
  name: string;
  status: "online" | "offline" | "draining";
  capabilities: Record<string, unknown>;
  lastSeenAt: string | null;
  registeredByActorType: string | null;
  registeredByActorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### `NodeKeyCreated` (from `packages/shared/src/types/node.ts`)

```typescript
interface NodeKeyCreated {
  id: string;
  nodeId: string;
  name: string;
  key: string;       // raw key, shown only at creation time
  createdAt: string;
}
```

### Zod Validators (from `packages/shared/src/validators/node.ts`)

- `createNodeSchema`: `{ name: string, capabilities?: Record, metadata?: Record }`
- `updateNodeSchema`: `{ name?: string, status?: NodeStatus, capabilities?: Record, metadata?: Record }`
- `createNodeKeySchema`: `{ name?: string }` (defaults to "default")

---

## Live Events

Three new event types added to the WebSocket live event system:

| Event | Payload | Purpose |
|-------|---------|---------|
| `node.run.available` | `{ runId, agentId, nodeId }` | Tells the runner a new run is queued for its node |
| `node.run.cancelled` | `{ runId, nodeId }` | Tells the runner to stop executing a run |
| `node.status` | `{ nodeId, status }` | Broadcast when a node's status changes (heartbeat) |

---

## Agent Configuration

When creating an agent with `adapter_type = "remote_node"`, the `adapterConfig` should contain:

```json
{
  "nodeId": "uuid-of-registered-node",
  "localAdapterType": "claude_local",
  "localAdapterConfig": {
    "cwd": "/path/on/remote/machine",
    "model": "claude-sonnet-4-5-20250514",
    "chrome": true
  },
  "timeoutSec": 3600
}
```

The `nodeId` links the agent to a specific node. When a heartbeat run is created, the server's `remote_node` adapter waits. The runner on that node claims the run, reads the `localAdapterType` and `localAdapterConfig`, and spawns the appropriate CLI tool.
