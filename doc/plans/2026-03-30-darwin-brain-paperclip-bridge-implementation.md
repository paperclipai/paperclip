# 2026-03-30 Darwin Brain Paperclip Bridge Implementation Plan

Status: Proposed
Date: 2026-03-30
Audience: Product and engineering
Related:
- `docs/superpowers/specs/2026-03-30-darwin-brain-paperclip-bridge-design.md`
- `doc/plugins/PLUGIN_SPEC.md`
- `packages/plugins/examples/plugin-kitchen-sink-example/`
- `/Users/jamie/Projects/skootle/skootle-demos/docs/darwin-semantic-search-mcp.md`

## 1. Purpose

This plan turns the approved Darwin Brain bridge spec into an implementable phase 1 plugin for Paperclip.

The outcome is a plugin that lets selected Paperclip agents search and store Darwin Brain knowledge with namespace-aware defaults and minimal governance controls.

## 2. Product Outcome

When phase 1 is complete:

1. Paperclip can install a Darwin Brain plugin from the repo workspace.
2. The plugin registers Darwin agent tools.
3. The plugin can call the existing Darwin MCP server over stdio.
4. Operators can configure default namespace and access mode.
5. Tenant-scoped agents can read and write in their own namespace.
6. Trusted agents can promote learnings into shared Darwin memory.

## 3. Scope

### In scope

- a new Paperclip plugin package
- Darwin MCP stdio client adapter inside the plugin worker
- four plugin tools:
  - `darwin.search`
  - `darwin.searchTenant`
  - `darwin.store`
  - `darwin.info`
- minimal instance and policy settings
- company and optional agent override resolution
- test coverage for tool behavior and access enforcement

### Out of scope

- deep plugin UI
- analytics or dashboards
- automatic promotion workflows
- bulk sync jobs
- changes to Darwin MCP protocol
- changes to Paperclip core governance

## 4. Build Strategy

Phase 1 should be built as a small dedicated plugin package in the Paperclip repo, following the current first-party example patterns.

The plugin should:

- use the worker entrypoint to register tools
- use instance config for Darwin service settings
- use plugin state for policy records if needed in phase 1
- add a small settings page only if required by current host wiring

The build should stay inside the plugin boundary rather than modifying Paperclip core.

## 5. Workstreams

## 5.1 Plugin scaffold

Create a new plugin package, tentatively:

- `packages/plugins/examples/plugin-darwin-brain-bridge`

Files:

- `package.json`
- `tsconfig.json`
- `src/manifest.ts`
- `src/worker.ts`
- `src/index.ts`
- `src/constants.ts`
- optional `src/ui/index.tsx`
- `README.md`

The initial scaffold should stay close to the kitchen-sink example but omit unrelated surfaces.

## 5.2 Darwin MCP client adapter

Build a small worker-side client module that:

- launches the Darwin MCP server as a child process
- performs MCP initialize handshake
- calls Darwin tools with JSON-RPC over stdio
- normalizes Darwin responses into Paperclip tool results
- surfaces clear upstream errors

Phase 1 should prefer a simple per-call or short-lived client path over a complex pooled process manager unless profiling shows that startup cost is unacceptable.

Inputs:

- Darwin MCP entrypoint path
- Upstash URL/token env var values or secret references

## 5.3 Tool registration

Register four tools through `ctx.tools.register`.

### `darwin.search`

- general semantic search
- available to any agent with plugin tool access
- intended for broad discovery

### `darwin.searchTenant`

- resolves namespace from policy
- default search path for operating agents
- fails closed if no namespace is configured

### `darwin.store`

- writes knowledge into resolved namespace
- allowed only for `read-write` or `promote`
- may target shared namespace only with `promote`

### `darwin.info`

- verifies Darwin service availability
- returns health/diagnostic information

## 5.4 Policy and settings resolution

Phase 1 needs a minimal but explicit policy model.

Recommended storage:

- plugin instance config for Darwin service connection and shared namespace
- plugin state records for company defaults and agent overrides

Policy fields:

- `companyId`
- `defaultNamespace`
- `defaultAccessMode`
- optional `agentId`
- optional `namespaceOverride`
- optional `accessModeOverride`

Resolution order:

1. agent override
2. company default
3. fail closed

Access modes:

- `read`
- `read-write`
- `promote`

## 5.5 Minimal settings surface

If the current host wiring supports plugin settings pages cleanly, add a minimal page for:

- Darwin MCP entrypoint
- shared namespace
- company default namespace
- company default access mode
- per-agent overrides for the first rollout companies

If UI wiring becomes a blocker, phase 1 may ship with config/state seeded through tests or operator tooling first, but the code should keep the settings model isolated so a UI can be added immediately after.

## 5.6 Tests

Add focused tests for:

- plugin manifest loading
- tool registration smoke test
- Darwin MCP handshake
- successful `darwin.search`
- successful `darwin.searchTenant`
- denied `darwin.store` for `read`
- allowed `darwin.store` for `read-write`
- denied shared promotion for non-`promote`
- allowed shared promotion for `promote`
- missing namespace rejection

Mock Darwin responses where possible. Add one integration-style test around the MCP transport seam.

## 6. Rollout Order

### Step 1

Scaffold the plugin package and register placeholder tools.

### Step 2

Implement Darwin MCP transport and make `darwin.info` work end-to-end.

### Step 3

Implement search tools.

### Step 4

Implement policy resolution and guarded store behavior.

### Step 5

Add minimal settings/config support.

### Step 6

Add tests and verify local plugin build/install flow.

### Step 7

Install on the active instance and enable for:

- `The Monitor Agency`
- Lua marketing

## 7. Risks

### MCP process lifecycle

If stdio lifecycle is brittle, tool calls may hang or leak child processes.

Mitigation:

- keep client adapter small
- use explicit timeouts
- close child processes deterministically

### Settings UX friction

If the plugin settings UI is not sufficiently mounted in the host, configuration may be awkward.

Mitigation:

- keep the storage model independent from UI
- ship the worker path first

### Shared-memory misuse

A wrong default could write into shared/global memory unintentionally.

Mitigation:

- fail closed
- default to tenant namespace only
- require explicit `promote` for shared writes

## 8. Success Criteria

This plan is complete when:

- the plugin builds successfully
- Paperclip can install it locally
- Monitor Agency can search/store in `monitor-agency`
- Lua marketing can search/store in `lua-marketing`
- shared promotion is limited to trusted agents
- the plugin requires no Paperclip core coupling for Darwin behavior
