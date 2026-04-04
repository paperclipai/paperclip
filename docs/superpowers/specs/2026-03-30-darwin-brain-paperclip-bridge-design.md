# Darwin Brain Paperclip Bridge Design

Date: 2026-03-30
Status: approved design for phase 1

## Goal

Expose Darwin Brain semantic memory to Paperclip agents through the Paperclip plugin system, with tenant-aware defaults and minimal governance controls.

Phase 1 must let selected agents:

- search Darwin Brain
- search a tenant namespace
- store knowledge in an allowed namespace
- inspect Darwin Brain health/info

Phase 1 must also give the operator a small settings surface for:

- default namespace per company
- optional per-agent namespace override
- access mode per company or agent
- whether shared-memory promotion is allowed

This should ship as a plugin boundary, not as a Paperclip core change.

## Why This Shape

Darwin Brain already exists as a standalone MCP server in `skootle-demos`. Paperclip already has a plugin runtime that supports agent tools and plugin settings. The cleanest integration is to bridge those two systems rather than reimplement Darwin search logic inside Paperclip or hardcode Darwin behavior into core models.

This gives the Darwin ecosystem compounding memory while keeping Paperclip governance intact:

- agencies keep local semantic memory
- trusted agents can promote durable learnings upward
- shared/global memory does not become an ungoverned dumping ground

## Scope

In scope for phase 1:

- one installable Paperclip plugin
- agent tools for Darwin Brain search and storage
- minimal operator settings for namespace and permission defaults
- tenant-safe defaults for existing companies such as `lua-marketing` and `monitor-agency`
- enforcement of read/write/promote policy at the plugin layer
- tests for tool execution, config enforcement, and Darwin MCP connectivity

Out of scope for phase 1:

- rich dashboards
- plugin-side analytics
- automatic knowledge promotion workflows
- long-running sync jobs
- direct edits to Paperclip core governance behavior
- changing the Darwin MCP server protocol

## Architecture

The bridge has four pieces.

### 1. Plugin manifest and worker

A new Paperclip plugin will be added under the plugin examples/workspace pattern and later promoted into the real plugin package layout if it proves stable. The plugin worker will register Darwin Brain tools through the existing `agent.tools.register` capability.

The plugin stays out of Paperclip core logic. It owns Darwin-specific execution, validation, and configuration lookup.

### 2. Darwin client adapter

Inside the plugin worker, a small Darwin client adapter will talk to the existing Darwin MCP server from `skootle-demos`.

Phase 1 recommendation:

- invoke the Darwin MCP server as a stdio subprocess from the plugin worker
- keep Upstash credentials in environment variables
- translate plugin tool calls into Darwin MCP tool calls

This avoids duplicating Darwin vector logic and keeps Darwin as the source of truth.

### 3. Settings and policy layer

The plugin will store operator-managed settings for:

- company default namespace
- optional per-agent namespace override
- access mode: `read`, `read-write`, or `promote`
- shared namespace name
- allowed shared-promotion agents

Resolution order:

1. explicit agent override
2. company default
3. fail closed

If no namespace can be resolved, `searchTenant` and `store` must reject the call.

### 4. Agent tool surface

The plugin will expose four tools:

- `darwin.search`
  - general semantic search
  - allowed for any agent with plugin access
- `darwin.searchTenant`
  - semantic search against resolved tenant namespace
  - default entry point for most operating agents
- `darwin.store`
  - store knowledge in the resolved namespace
  - only available to agents with `read-write` or `promote`
- `darwin.info`
  - Darwin health and namespace diagnostics
  - available for operators and debugging

Phase 1 deliberately does not expose a generic "write anywhere" tool.

## Data Flow

### Search flow

1. Agent calls `darwin.search` or `darwin.searchTenant`
2. Plugin resolves the calling company and agent context
3. Plugin loads effective namespace and access policy
4. Plugin invokes the Darwin MCP server tool
5. Plugin returns normalized results to the agent run

### Store flow

1. Agent calls `darwin.store`
2. Plugin resolves namespace and effective access mode
3. Plugin rejects the call unless access mode allows writes
4. Plugin invokes Darwin MCP `darwin_store`
5. Plugin returns a compact confirmation payload

### Promotion flow

Phase 1 handles promotion as a guarded variant of `darwin.store`.

- only agents with `promote` access may target shared/global namespace
- promotion still goes through the same `store` path
- default behavior is deny

This keeps phase 1 small while still supporting trusted strategic agents.

## Configuration Model

The plugin settings model should support:

- shared Darwin service config
  - MCP server entrypoint
  - environment variable names or secret references for Upstash URL/token
  - shared namespace identifier
- company policy records
  - company id
  - default Darwin namespace
  - default access mode
- optional agent policy records
  - agent id
  - namespace override
  - access mode override

Initial recommended defaults:

- Lua marketing company default namespace: `lua-marketing`
- Monitor Agency company default namespace: `monitor-agency`
- shared namespace: Darwin global/shared namespace already used by the Darwin ecosystem

Initial recommended access:

- marketing specialists: `read-write`
- Monitor Agency scouts: `read-write`
- `THEO`, trusted CEOs, and selected escalation agents: `promote`
- everyone else: `read`

## Error Handling

The plugin must fail safely and clearly.

- If Darwin MCP cannot start or respond, tool calls return a clear runtime error without crashing the agent run host.
- If namespace config is missing, tenant-scoped actions fail with a configuration error.
- If an agent attempts a disallowed write or promotion, the plugin returns an authorization error.
- If Darwin returns malformed data, the plugin returns a sanitized upstream error and logs plugin diagnostics.

The plugin must never silently fall back to shared/global writes.

## Testing

Phase 1 test coverage should include:

- Darwin MCP handshake from the plugin worker
- tool registration smoke test
- `darwin.search` success path
- `darwin.searchTenant` with resolved company default
- `darwin.store` allowed for `read-write`
- `darwin.store` rejected for `read`
- promotion rejected without `promote`
- promotion allowed for `promote`
- missing namespace fails closed

Tests should run against the plugin boundary, not require invasive Paperclip core changes.

## Rollout

Phase 1 rollout should be conservative:

1. build the plugin in the Paperclip repo
2. validate in isolated dev usage
3. install locally on the active Paperclip instance
4. enable for `The Monitor Agency` and Lua marketing first
5. keep promotion access limited to trusted agents

Only after that proves stable should broader companies get Darwin access.

## Success Criteria

Phase 1 is successful when:

- a Monitor Agency agent can search and store in `monitor-agency`
- a Lua marketing agent can search and store in `lua-marketing`
- a trusted strategic agent can promote a learning into shared Darwin memory
- namespace and permission mistakes fail closed
- the bridge is implemented as a plugin, not as Paperclip core coupling
