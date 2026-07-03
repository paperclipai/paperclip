# ADR: MCP client — build vs buy (NEO-286 Direction 2)

- **Status:** Accepted (Board approved NEO-286 plan rev 2 + S1 sourcing, 2026-07-02)
- **Owners:** Werner (plan author), Anders (implementation)
- **Related:** NEO-286 (parent), NEO-348 / [`docs/mcp-client-porting-4259.md`](./mcp-client-porting-4259.md) (D2-0 port report), NEO-349 (this ADR + scaffolding), upstream `paperclipai/paperclip` PR #4259

## Context

Cortex needs to act as an **MCP client**: fleet agents consuming external / third-party MCP
servers (GitHub, Slack, …), configured per company, with per-agent tool visibility and encrypted
credentials at rest. This is the mirror of Direction 1, which shipped the MCP **server** side
(`@paperclipai/mcp-server`).

Three questions had to be decided before implementation:

1. **Wire layer:** hand-rolled JSON-RPC vs the official `@modelcontextprotocol/sdk` client vs an
   mcporter-backed stack.
2. **Sourcing of the multi-tenant layer:** port upstream PR #4259 (S1), wait for upstream to merge
   it (S2), or build greenfield (S3).
3. **Transport ordering:** upstream #4259 shipped stdio-first; stdio spawn is an RCE-class surface
   on the control-plane host.

## Decision

### 1. Wire layer: official SDK client + our own multi-tenant manager (Option A)

The MCP wire/protocol layer (connect stdio/http/sse, initialize, list/call tools, lifecycle) is
**bought**: `@modelcontextprotocol/sdk` client half
(`client/{index,streamableHttp,sse,stdio}.js`). It is already a workspace dependency at `^1.29.0`
via `packages/mcp-server`, so this adds zero new vendor surface; `server` now declares the same
dependency directly.

The multi-tenant layer — registry, authz, credential injection, per-agent tool filtering, pooling —
is **built**, in `server/src/services/mcp-client-manager.ts`. No library provides it; it is
Cortex-specific.

**mcporter is rejected as the backbone.** Its two headline features (local config discovery from
Cursor/Claude Desktop/Codex, and a local credential vault at `~/.mcporter/credentials.json`) are
built for one developer's machine and are the opposite of a server-side, per-company model. We
would bypass both and use only its inner client — which is the official SDK plus ergonomics we
don't need. Adopting it means fighting its grain while enlarging the dependency surface
(single-maintainer package) for no capability gain. Two ideas are borrowed without adoption: the
code-execution-with-MCP exposure pattern (context-bloat control) and ecosystem tracking.

Consequence for the ported code: the ~250-line hand-rolled `StdioJsonRpcClient` in
`server/src/services/mcp-servers.ts` (manual `Content-Length` framing, custom timeout/kill
handling) is **transitional** and will be replaced by SDK transports behind the manager
(NEO-351 / D2-3). The service's public surface (list/create/update/delete/test/discover,
`listBindingsForAgent`) is the seam for that swap.

### 2. Sourcing: S1 — port upstream #4259, then harden

Evaluated in D2-0 (NEO-348; verdict and full reconciliation in
[`docs/mcp-client-porting-4259.md`](./mcp-client-porting-4259.md)): upstream PR #4259 is ~90% of
Direction 2 (schema, services, routes, board UI, agent tool APIs) and cherry-picked onto Cortex
with a manageable conflict surface. It independently chose the same server-side execution model we
did (agents list/execute bound MCP tools through Paperclip, not via adapter prompt injection),
and the same `local_encrypted` credential model.

- **S2 (wait for upstream merge)** rejected: all relevant upstream PRs are open with no committed
  timeline; cedes control of a security-sensitive subsystem.
- **S3 (greenfield)** rejected: duplicates ~4–5k lines upstream already wrote, and risks diverging
  from a design upstream may still merge. Kept as the reference shape only.
- **Adapter-native path** (upstream #1800: hand the CLI agent an `--mcp-config`) deferred: it
  externalizes credential handling to the CLI layer and is harder to govern centrally. Server-side
  registry is the tenant-safe default for v1.

### 3. Transport ordering: http/sse first, stdio gated

Phase 1 implements **http (streamable) and sse** transports only (NEO-351 / D2-3). **stdio stays
gated**: a company-configured `command` is arbitrary process launch on the control-plane host.
stdio execution ships only in a later phase behind an explicit allowlist/admin-approval gate and a
dedicated security review, per plan §4/§8 (D2-6). The manager skeleton encodes this: stdio targets
are refused at the pool boundary, not merely unimplemented.

Everything remains behind the `PAPERCLIP_MCP_CLIENT_ENABLED` feature flag (default off), added
during the D2-0 port.

## Consequences

- One Anthropic-maintained protocol dependency we already ship; no hand-rolled framing to maintain.
- The manager owns per-company client pools keyed `(companyId, mcpServerId)`; no cross-company
  view is reachable structurally — the fix for the global-dispatcher tenant-leak identified in
  NEO-283.
- Porting #4259 means inheriting its quality debts; they are tracked explicitly (stdio-first debt,
  thin governance) and burned down in D2-3..D2-7 rather than rewritten wholesale.
- Test placement note: `packages/mcp-server` vitest suites are absent from the root
  `vitest.config.ts` projects list and therefore never run in CI. Client-manager code and tests
  live under `server/src/`, whose suite runs in the `general-server` group of `pr.yml`.
