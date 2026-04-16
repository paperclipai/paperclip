# Memory Architecture

This document describes how Paperclip's memory system splits responsibility between the upstream control plane and the local adapter layer. It covers the built-in PARA adapter and the hook system that drives automatic memory operations.

## Overview

Paperclip's memory system is a two-layer architecture:

1. **Upstream control plane** (Paperclip server, backed by Postgres) — owns bindings, scope mapping, provenance, lifecycle hooks, and operation logging. This is the framework layer: it decides _when_ memory operations happen, _who_ they apply to, and _what_ metadata is recorded.
2. **Local adapter layer** — owns storage, indexing, and retrieval. Adapters implement the `MemoryAdapter` interface (`write`, `query`, `get`, `forget`) and declare optional capabilities via `MemoryAdapterCapabilities`. The built-in adapter is **PARA** (filesystem-based, using Tiago Forte's PARA hierarchy).

Agents never interact with memory providers directly. The server mediates all memory operations and injects results into agent context.

The adapter interface is open — additional implementations can be registered alongside PARA (e.g., MCP-based adapters or custom storage backends), giving deployments flexibility to choose providers that suit their needs.

## Lifecycle Hooks

Memory operations are driven by **lifecycle hooks** attached to **memory bindings**. Two hooks exist:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `preRunHydrate` | Before an agent run | Query memory for relevant context and inject it into the run |
| `postRunCapture` | After an agent run completes | Write a summary of the run into memory for future recall |

### Hook activation

Hooks are **system-initiated when configured and enabled**, not universally mandatory. Each hook has an `enabled: boolean` field in the binding config. When a binding exists but a hook is disabled or absent, the system skips it with no side effects:

- `preRunHydrate` — bindings are filtered to those with `hooks.preRunHydrate?.enabled === true`; if none match, hydration returns zero snippets and the run proceeds without injected memory context (`memory-hooks.ts:177-183`).
- `postRunCapture` — bindings are filtered to those with `hooks.postRunCapture?.enabled === true`; if none match, capture is a no-op (`memory-hooks.ts:297-303`).

This means a company can register a memory adapter without any hooks firing until a binding explicitly enables them.

## Security Model

Company isolation is enforced at two levels, matching the two-layer architecture:

### Upstream (control plane)

The Paperclip server enforces isolation before any adapter is called:

- Memory bindings are scoped to a company. The server only dispatches operations to adapters that have a binding targeting the requesting agent's company.
- All memory operations are logged to the `memory_operations` table with full scope metadata, providing an audit trail at the framework level.
- Scope (`MemoryScope`) is injected by the server — agents cannot forge or escalate their own scope.

### Local (PARA adapter)

PARA enforces company isolation at the filesystem path level:

- All file operations are scoped to `basePath/<companyId>/` directories.
- `companyId` is validated as a UUID (`/^[0-9a-f]{8}-…$/i`) before any path resolution, preventing directory traversal via malformed scope values (`para.ts:217-222`).
- Resolved paths are checked to ensure they remain within the company base directory — any path that escapes triggers a traversal error (`para.ts:231-236`).

### Summary

| Concern | Upstream (framework/Postgres) | Local (PARA adapter) |
|---------|-------------------------------|----------------------|
| Company isolation | Binding-scoped dispatch; agents only reach their own company's adapters | Filesystem path scoping with UUID validation |
| Traversal prevention | Scope injected server-side; agents cannot forge scope | Path-resolution check against company base dir |
| Sub-company scoping | Scope fields (`projectId`, `agentId`, `issueId`) carried on every request | Directory structure (PARA hierarchy) |
| Audit | `memory_operations` table logs every operation | Filesystem timestamps |

Because the adapter interface is open, alternative adapters may use different local isolation strategies (e.g., process-level separation, network-level scoping). Each adapter is responsible for documenting its own isolation guarantees.

## Adapter Interface

All adapters implement the `MemoryAdapter` interface from `@paperclipai/plugin-sdk`:

```typescript
interface MemoryAdapter {
  key: string;
  capabilities: MemoryAdapterCapabilities;
  write(req: MemoryWriteRequest): Promise<{ records?: MemoryRecordHandle[]; usage?: MemoryUsage[] }>;
  query(req: MemoryQueryRequest): Promise<MemoryContextBundle>;
  get(handle: MemoryRecordHandle, scope: MemoryScope): Promise<MemorySnippet | null>;
  forget(handles: MemoryRecordHandle[], scope: MemoryScope): Promise<{ usage?: MemoryUsage[] }>;
}
```

Scope is carried via `MemoryScope` on every request:

```typescript
interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
  subjectId?: string;
}
```

## Memory Bindings

Bindings connect adapters to companies/agents and configure which hooks are active. They are stored in the `memory_bindings` and `memory_binding_targets` database tables.

A binding specifies:
- **Provider key** — which registered adapter to use (e.g. `para`)
- **Hook config** — which lifecycle hooks are enabled and their parameters
- **Targets** — which company or agent(s) the binding applies to

Without a binding targeting a given agent's company, no memory operations fire for that agent's runs — even if the adapter is registered.

## Error Handling

Memory failures never block agent runs. The system has four layers of defense:

1. **Adapter level** — auto-reconnect on call failure (handles container restarts)
2. **Sidecar level** (local mode only) — health checks every 30s, auto-restart with exponential backoff
3. **Hook level** — each binding operation is individually try/caught, failures logged to `memory_operations`
4. **Heartbeat level** — entire memory hydration and capture blocks are try/caught; runs proceed without memory context on failure
