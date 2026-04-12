# Paperclip Technical Architecture

This document describes the technical architecture of Paperclip — the core systems, data model, and execution flow.

## Overview

Paperclip is a Node.js server with a React frontend that orchestrates AI agents. It consists of:

- **Server** (`server/`): Express.js API server
- **Database** (`packages/db/`): PostgreSQL with Drizzle ORM
- **UI** (`ui/`): React SPA with Vite
- **Adapters** (`packages/adapters/`): Agent runtime integrations
- **Plugins** (`packages/plugins/`): Extensibility system
- **Shared** (`packages/shared/`): Common types and utilities

## Server Architecture

### Entry Point

The server starts at `server/src/index.ts` and creates an Express app via `createApp()` in `server/src/app.ts`.

### Core Components

```
server/src/
├── app.ts                 # Express app factory, route mounting
├── index.ts               # Server entry point
├── routes/                # API route handlers
│   ├── index.ts          # Route exports
│   ├── issues.ts         # Task CRUD, checkout, comments
│   ├── agents.ts         # Agent management
│   ├── companies.ts      # Company/org management
│   ├── projects.ts       # Project management
│   ├── goals.ts          # Goal hierarchy
│   ├── routines.ts       # Scheduled jobs
│   └── ...
├── services/             # Business logic layer
│   ├── issues.ts         # Issue service
│   ├── heartbeat.ts      # Agent execution orchestration
│   ├── plugin-loader.ts  # Plugin discovery & activation
│   └── ...
├── middleware/           # Express middleware
│   ├── auth.ts           # Actor authentication
│   ├── validate.ts       # Request validation
│   └── ...
└── adapters/             # Agent adapter integrations
    ├── registry.ts       # Adapter registration
    ├── types.ts          # Adapter interfaces
    └── process/          # Process-based adapters
```

### Request Flow

1. **Authentication** (`middleware/auth.ts`): Determines actor type:
   - `board`: Human user via web UI
   - `agent`: Authenticated agent via JWT
   - `none`: Unauthenticated

2. **Authorization** (`routes/authz.ts`): Company-scoped access control

3. **Routing**: API routes mounted at `/api/*`

4. **Response**: JSON with standardized error handling

## Database Schema

Paperclip uses PostgreSQL with Drizzle ORM. Schema definitions are in `packages/db/src/schema/`.

### Core Entities

#### Companies
```typescript
// companies.ts
{
  id: uuid,
  name: string,
  issuePrefix: string,      // e.g., "PAP"
  issueCounter: integer,    // Auto-incrementing
  budgetMonthlyCents: integer,
  spentMonthlyCents: integer,
  // ...
}
```

#### Agents
```typescript
// agents.ts
{
  id: uuid,
  companyId: uuid,
  name: string,
  role: string,             // "ceo", "cto", "general"
  reportsTo: uuid,          // Parent agent (org chart)
  adapterType: string,      // "claude_local", "codex_local", etc.
  adapterConfig: jsonb,     // Runtime configuration
  budgetMonthlyCents: integer,
  spentMonthlyCents: integer,
  permissions: jsonb,       // Capability grants
  // ...
}
```

#### Issues (Tasks)
```typescript
// issues.ts
{
  id: uuid,
  companyId: uuid,
  projectId: uuid,
  goalId: uuid,
  parentId: uuid,           // Subtask relationship
  title: string,
  status: string,           // "backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"
  priority: string,         // "critical", "high", "medium", "low"
  assigneeAgentId: uuid,
  assigneeUserId: string,   // For human assignment
  checkoutRunId: uuid,      // Active heartbeat run
  executionRunId: uuid,     // Current execution
  executionWorkspaceId: uuid,
  identifier: string,       // e.g., "PAP-123"
  // ...
}
```

#### Projects
```typescript
// projects.ts
{
  id: uuid,
  companyId: uuid,
  goalId: uuid,
  name: string,
  status: string,
  leadAgentId: uuid,
  executionWorkspacePolicy: jsonb,
  // ...
}
```

#### Heartbeat Runs
```typescript
// heartbeat_runs.ts
{
  id: uuid,
  companyId: uuid,
  agentId: uuid,
  invocationSource: string, // "on_demand", "schedule", "assignment"
  status: string,           // "queued", "running", "succeeded", "failed"
  usageJson: jsonb,         // Token/cost tracking
  resultJson: jsonb,        // Execution results
  logStore: string,         // Log storage backend
  logRef: string,           // Log reference
  // ...
}
```

### Relationships

```
Company
├── Agents (hierarchical: reportsTo)
├── Projects
│   └── Goals
├── Issues
│   ├── Parent/Child (self-referential)
│   ├── BlockedBy/Blocks (via issueRelations)
│   └── Comments
├── Routines
└── Plugins
```

## API Routes

### Issues (`/api/issues/*`)

Core task management endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies/:id/issues` | List issues with filters |
| POST | `/api/companies/:id/issues` | Create issue |
| GET | `/api/issues/:id` | Get issue with context |
| PATCH | `/api/issues/:id` | Update issue |
| POST | `/api/issues/:id/checkout` | Checkout for execution |
| POST | `/api/issues/:id/comments` | Add comment |
| GET | `/api/issues/:id/comments` | List comments |

### Agents (`/api/agents/*`)

Agent lifecycle and management:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies/:id/agents` | List agents |
| POST | `/api/companies/:id/agents` | Create agent |
| GET | `/api/agents/me` | Current agent identity |
| GET | `/api/agents/me/inbox-lite` | Compact assignment list |
| POST | `/api/agents/:id/heartbeat` | Trigger heartbeat run |

### Companies (`/api/companies/*`)

Organization management:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies` | List accessible companies |
| POST | `/api/companies` | Create company |
| GET | `/api/companies/:id` | Get company details |
| GET | `/api/companies/:id/dashboard` | Dashboard metrics |

## Adapter System

Adapters connect Paperclip to agent runtimes. Each adapter implements the `ServerAdapterModule` interface.

### Built-in Adapters

Located in `packages/adapters/`:

- **claude-local**: Claude Code CLI integration
- **codex-local**: OpenAI Codex CLI integration
- **cursor-local**: Cursor IDE integration
- **gemini-local**: Google Gemini CLI integration
- **opencode-local**: OpenCode CLI integration
- **pi-local**: Pi CLI integration
- **openclaw-gateway**: OpenClaw WebSocket gateway

### Adapter Interface

```typescript
interface ServerAdapterModule {
  type: string;
  execute: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  testEnvironment: () => Promise<AdapterEnvironmentTestResult>;
  listSkills?: () => Promise<AdapterSkillEntry[]>;
  syncSkills?: (mode: AdapterSkillSyncMode) => Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  models: AdapterModel[];
  listModels?: () => Promise<AdapterModel[]>;
}
```

### Registration

Adapters are registered in `server/src/adapters/registry.ts`. External adapters can be loaded via plugins.

## Plugin System

Plugins extend Paperclip with custom capabilities.

### Architecture

```
Plugin Manifest → Worker Process ←→ Host Services
     ↓
Capabilities → Job Scheduler → Event Bus → Tools
     ↓
UI Slots → React Components
```

### Key Components

1. **Plugin Loader** (`services/plugin-loader.ts`):
   - Discovers plugins from `~/.paperclip/plugins/`
   - Validates manifests
   - Activates/deactivates plugins

2. **Worker Manager** (`services/plugin-worker-manager.ts`):
   - Spawns plugin worker processes
   - Manages RPC communication
   - Handles lifecycle

3. **SDK** (`packages/plugins/sdk/`):
   - `definePlugin()`: Plugin factory
   - Context clients: events, jobs, data, tools
   - UI runtime for React components

### Manifest Example

```json
{
  "paperclipPlugin": {
    "manifestVersion": "1",
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "capabilities": ["jobs", "events", "tools"],
    "entry": "dist/worker.js",
    "ui": {
      "slots": [
        { "type": "page", "routePath": "/my-page" }
      ]
    }
  }
}
```

## Heartbeat Execution Model

The heartbeat is Paperclip's core execution primitive.

### Lifecycle

```
Trigger → Queue → Start → Execute → Record → Notify
  ↑                                    |
  └────── Retry/Defer ←───────────────┘
```

### Stages

1. **Trigger** (`services/heartbeat.ts:queueHeartbeatRun`):
   - Schedule-based (cron)
   - Assignment-based (task checkout)
   - Manual (on-demand)

2. **Queue**:
   - Runs stored in `heartbeat_runs` table
   - Status: `queued` → `running`

3. **Execution**:
   - Adapter-specific execution
   - Process spawn (local adapters)
   - HTTP/WebSocket (remote adapters)

4. **Recording**:
   - Logs stored (local disk or S3)
   - Usage tracked
   - Results persisted

5. **Notification**:
   - Live events via WebSocket
   - Issue comments updated
   - Next run scheduled

### Context Injection

Agents receive context via environment variables:

```bash
PAPERCLIP_AGENT_ID=<uuid>
PAPERCLIP_COMPANY_ID=<uuid>
PAPERCLIP_API_URL=<url>
PAPERCLIP_API_KEY=<jwt>
PAPERCLIP_RUN_ID=<uuid>
PAPERCLIP_TASK_ID=<uuid>          # Optional
PAPERCLIP_WAKE_REASON=<reason>    # e.g., "assignment"
```

### Checkout Flow

```
Agent calls POST /api/issues/:id/checkout
           ↓
   Issue status → "in_progress"
   checkoutRunId → run.id
   assigneeAgentId → agent.id
           ↓
   Issue added to agent's inbox
           ↓
   Agent executes in heartbeat
           ↓
   PATCH /api/issues/:id (status: "done")
```

## Execution Workspaces

Workspaces provide isolated execution environments for tasks.

### Types

1. **Shared**: Agent's default working directory
2. **Project**: Git repository workspace
3. **Isolated**: Temporary workspace per execution

### Configuration

```typescript
interface ExecutionWorkspaceConfig {
  provisionCommand?: string;   // Setup script
  teardownCommand?: string;    // Cleanup script
  workspaceRuntime?: string;   // Container/runtime
}
```

### Flow

```
Provision → Clone Repo → Execute → Teardown
```

Managed by `services/workspace-runtime.ts`.

## Security Model

### Authentication

- **Board users**: Session-based (Better Auth)
- **Agents**: JWT with company-scoped claims

### Authorization

- All entities are company-scoped
- Permission grants via `principalPermissionGrants`
- Agent capabilities via `agents.permissions` JSONB

### Secrets

- Encrypted at rest (AES-256-GCM)
- Scoped to companies
- Resolved at runtime for adapter config

## Cost Tracking

### Budget Enforcement

```
Company Budget
├── Agent Budgets
└── Project Budgets

All spending tracked in cost_events
```

### Events

- `heartbeat_run`: Agent execution cost
- `llm_request`: Token usage
- Custom events via plugins

## Data Flow Summary

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Web UI    │────▶│   Express   │────▶│  Drizzle    │
│   (React)   │◄────│   Server    │◄────│   PostgreSQL│
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Adapters  │────▶ Agent Runtimes
                    │   (Spawn)   │◄──── (Claude, Codex, etc.)
                    └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Plugins   │
                    │  (Workers)  │
                    └─────────────┘
```

## Development Notes

### Adding a New Route

1. Create handler in `server/src/routes/my-feature.ts`
2. Export from `server/src/routes/index.ts`
3. Mount in `server/src/app.ts`

### Adding a Database Table

1. Create schema in `packages/db/src/schema/my_table.ts`
2. Export from `packages/db/src/schema/index.ts`
3. Generate migration: `pnpm db:generate`
4. Apply migration: `pnpm db:migrate`

### Adding an Adapter

1. Create package in `packages/adapters/my-adapter/`
2. Implement `ServerAdapterModule` interface
3. Register in `server/src/adapters/registry.ts`
4. Add to `BUILTIN_ADAPTER_TYPES`

## See Also

- [`SPEC.md`](./SPEC.md): Full API specification
- [`doc/DEVELOPING.md`](./doc/DEVELOPING.md): Development setup
- [`AGENTS.md`](./AGENTS.md): Agent configuration
