# Paperclip Integration Plan

> Making Paperclip the central agent management hub for all agents across all servers.

## Vision

Paperclip becomes the **org layer** for all AI agents. One dashboard to manage, monitor, and coordinate agents regardless of where they run or what framework they use.

```
┌──────────────────────────────────────────────────────┐
│                    Paperclip                          │
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Org Chart  │  │ Goals &    │  │ Budget &     │  │
│  │ & Agents   │  │ Tasks      │  │ Governance   │  │
│  └────────────┘  └────────────┘  └──────────────┘  │
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Inbox &    │  │ Activity   │  │ Adapter      │  │
│  │ Comms      │  │ Log        │  │ Registry     │  │
│  └────────────┘  └────────────┘  └──────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │          Adapter Layer (pluggable)            │   │
│  │  claude_local │ hermes_local │ openclaw_local│   │
│  │  codex_local  │ http_agent   │ ...           │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
     │              │                │              │
     ▼              ▼                ▼              ▼
┌─────────┐  ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Claude  │  │  Hermes  │   │ OpenClaw │   │  Remote  │
│ (local) │  │  (local) │   │  (local) │   │  (HTTP)  │
└─────────┘  └──────────┘   └──────────┘   └──────────┘
     │              │                │              │
     └──────────────┴────────┬───────┴──────────────┘
                             │
                      ┌──────▼──────┐
                      │   Cabinet   │  ← Shared memory
                      │  (optional) │
                      └─────────────┘
```

## Current Architecture (What Exists)

### Adapter System
- **Interface:** `server/src/adapters/types.ts`
- **Registry:** `server/src/adapters/registry.ts`
- **Built-in types:** `server/src/adapters/builtin-adapter-types.ts`
- **Plugin loader:** `server/src/adapters/plugin-loader.ts`
- **Current adapters:** claude_local, codex_local, opencode_local, hermes_local, cursor, gemini_local, pi_local

### Agent Management
- Agents have: adapterType, provider, goals, instructions, workspace
- Org chart defines hierarchy
- Activity log tracks all actions
- Budget system with hard stops

### Execution
- Heartbeat: periodic agent runs
- Issue-based: agents work on issues
- Routines: scheduled tasks
- Approval gates for governed actions

## What Needs To Change

### Phase 1: Hermes Agent Adapter

Hermes already runs as `hermes_local` in Paperclip but needs deeper integration.

#### 1.1 Hermes Adapter Enhancements

```
Current: hermes_local runs hermes CLI as a process
Target:  hermes_local integrates with Hermes's full feature set
```

Features to integrate:
- **Skills:** Paperclip issues map to Hermes skills
- **Memory:** Hermes memory syncs with Cabinet (if connected)
- **Cron:** Hermes cron jobs visible in Paperclip
- **Multi-platform:** Hermes's Telegram/Discord/WhatsApp status shown in Paperclip
- **Sessions:** Hermes session history visible in Paperclip activity log

#### 1.2 Hermes Bootstrap Prompt

The bootstrap prompt for hermes_local should:
1. Read the assigned issue from Paperclip
2. Load relevant skills from Hermes's skill system
3. Write memory to Cabinet (if connected)
4. Report progress back to Paperclip via activity log

### Phase 2: OpenClaw Agent Adapter

#### 2.1 OpenClaw Adapter Type

Create `openclaw_local` adapter:

```typescript
// server/src/adapters/openclaw/index.ts
export const openclawAdapter: ServerAdapterModule = {
  type: "openclaw_local",
  name: "OpenClaw Agent",
  execute: async (ctx) => {
    // Call OpenClaw's gateway API
    // POST to http://localhost:18789/api/sessions
    // Stream response back
  },
  healthCheck: async () => {
    // Check openclaw gateway status
  }
};
```

#### 2.2 OpenClaw Integration Points

- **Gateway API:** OpenClaw runs on port 18789, has REST + WebSocket
- **Agents:** OpenClaw has multiple agents (main, researcher, developer, etc.)
- **Channels:** WhatsApp, Telegram, Discord — status visible in Paperclip
- **Memory:** OpenClaw memory via qmd backend — sync to Cabinet

### Phase 3: Remote Agent Support

#### 3.1 HTTP Agent Adapter

Generic adapter for any agent with an HTTP API:

```typescript
{
  type: "http_agent",
  config: {
    endpoint: "http://192.168.1.50:8080",
    authHeader: "Bearer ...",
    promptEndpoint: "/api/prompt",
    healthEndpoint: "/api/health",
    streamEndpoint: "/api/stream"
  }
}
```

#### 3.2 Multi-Server Agent Registry

Paperclip discovers and manages agents across servers:

```
Paperclip Server (main)
├── Local agents (claude, hermes, openclaw)
├── Remote agents (registered via HTTP)
│   ├── hermes-prod (192.168.1.50)
│   ├── openclaw-worker (192.168.1.51)
│   └── custom-agent (192.168.1.52)
└── Cabinet connection (shared memory)
```

### Phase 4: Cabinet Integration

#### 4.1 Memory-Aware Agent Management

When Cabinet is connected:
- Agent memory visible in Paperclip UI
- Cross-agent knowledge sharing
- Memory-based agent routing (agent with relevant knowledge gets the task)
- Audit trail of all memory changes

#### 4.2 Configuration

```json
{
  "cabinet": {
    "endpoint": "http://localhost:3000",
    "memorySync": "bidirectional",
    "autoSyncInterval": 300
  }
}
```

## Implementation Order

1. **Hermes deep integration** — Skills, memory sync, multi-platform status
2. **OpenClaw adapter** — Gateway API integration
3. **HTTP agent adapter** — Generic remote agent support
4. **Multi-server registry** — Discover and manage agents across servers
5. **Cabinet integration** — Shared memory layer

## Key Files

| File | Purpose |
|------|---------|
| `server/src/adapters/types.ts` | Adapter interface |
| `server/src/adapters/registry.ts` | Adapter registry |
| `server/src/adapters/plugin-loader.ts` | External adapter loading |
| `server/src/adapters/process/execute.ts` | Process-based execution |
| `server/src/adapters/http/execute.ts` | HTTP-based execution |
| `server/src/services/agents.ts` | Agent management |
| `server/src/services/heartbeat.ts` | Heartbeat orchestration |
| `packages/db/src/schema/` | Database schema |

## Adapter Plugin System

Paperclip already supports external adapters via plugins. New adapters can be:

1. **Built-in:** Added to `server/src/adapters/` (like claude_local)
2. **Plugin:** NPM package loaded via `~/.paperclip/adapter-plugins.json`
3. **HTTP:** Generic HTTP adapter pointed at any agent API

The hermes_local and openclaw_local adapters should be built-in for tight integration.

## Principles

1. **Agent-agnostic management** — Paperclip doesn't care what the agent is
2. **Adapter pattern** — Each agent type is an adapter
3. **Activity logging** — Everything agents do is logged
4. **Budget enforcement** — Hard stops on cost/runs
5. **Governance** — Approval gates for sensitive actions
6. **Audit trail** — Every action traceable to an agent + reason
