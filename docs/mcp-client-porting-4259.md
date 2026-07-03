# Reconciliation report — porting upstream PR #4259 onto Cortex (NEO-348 / NEO-286 D2-0)

**Upstream PR:** `paperclipai/paperclip` #4259 — "feat: add company-scoped MCP server registry"
**Feature commit:** `1cb28860` (single commit; the PR's second commit is just a merge of upstream master)
**PR base:** upstream `a9573944` · **Cortex master at port time:** `6107b8ff` (24 commits ahead of, 79 behind, upstream master)
**Port branch:** `mcp-client` (cherry-pick of `1cb28860` + Cortex fixups + feature flag)
**Flag:** `PAPERCLIP_MCP_CLIENT_ENABLED` (default **off**; see "Feature flag" below)

## Verdict: S1 is viable — go

The PR is one coherent feature commit and ~90% of Direction 2 as advertised. It cherry-picks onto
Cortex with a manageable conflict surface (12 files, all wiring/doc-style conflicts, no logic
conflicts). All affected packages typecheck after the port. The headline +61k insertions are
misleading: ~45k of that is generated Drizzle snapshot JSON we discard; real code is roughly
4–5k lines (server ~1.5k, shared types/validators ~1k, UI ~1.2k, the rest docs/wiring).

## What ports cleanly

| Area | Files | Notes |
| --- | --- | --- |
| DB schema (Drizzle TS) | `packages/db/src/schema/{mcp_servers,agent_mcp_servers,mcp_server_catalog_snapshots}.ts` | Self-contained; FKs only to `companies`/`agents`. No collisions with Cortex tables. |
| Shared types/validators | `packages/shared/src/{types,validators}/mcp-*.ts`, `agent-mcp-*.ts`, `workspace-mcp.ts` | Pure additions. Barrel (`index.ts`) conflicts were unions. |
| Server services | `server/src/services/mcp-servers.ts` (919 lines), `agent-mcp-tools.ts` | Compile as-is. Factories are pure closures — no construction-time side effects; `spawn` happens only on discovery/execute calls. |
| Routes | `server/src/routes/mcp-servers.ts` + 2 routes in `routes/agents.ts` (`GET /agents/me/mcp-tools`, `POST .../execute`) | Company routes use `assertBoard` + `assertCompanyAccess`; agent routes require agent actor (execute additionally requires run-scoped auth). |
| Heartbeat context | `server/src/services/heartbeat.ts` | Injects `paperclipAvailableMcpTools` / `paperclipAgentMcpServers` (+ workspace-level `paperclipMcpServers`) into run context. |
| Adapter prompt | `packages/adapter-utils/src/server-utils.ts` (`buildPaperclipMcpPrompt`), `claude-local`, `codex-local` | claude-local auto-merged; codex-local re-applied by hand (Cortex rewrote that file — 4-line intent: import, build, join, metrics). |
| Board UI | `CompanyMcpServers.tsx` (803 lines), `AgentMcpServersTab.tsx`, `api/mcpServers.ts`, queryKeys, routes | Ports cleanly; nav-item conflicts resolved by hand. |
| Credentials | stdio `env` uses the standard secret-aware env-binding model (`resolveEnvBindings` / `normalizeEnvBindingsForPersistence`) | **Matches Cortex's `localEncryptedProvider` — keep as-is** (per the D2 plan). |

## What conflicts, and how it was resolved

12 conflicted files on cherry-pick, all resolved on the `mcp-client` branch:

- `server/src/app.ts`, `server/src/routes/agents.ts`, `server/src/services/heartbeat.ts` — Cortex signature drift (`pluginWorkerManager` options, extra services). Kept Cortex wiring, added MCP registrations. One duplicate `secretService` import removed.
- `packages/shared/src/index.ts` — barrel export lists; union.
- `packages/adapters/codex-local/src/server/execute.ts` — file rewritten on Cortex; PR hunks re-applied by intent (see table above).
- `ui/src/components/{Sidebar,CompanySettingsSidebar}.tsx`, `ui/src/pages/ExecutionWorkspaceDetail.tsx` — Cortex nav/tab systems diverged; MCP items inserted into Cortex structures.
- `README.md`, `doc/DATABASE.md`, `doc/SPEC-implementation.md`, `skills/paperclip/SKILL.md` — doc unions; kept Cortex section numbering and the Cortex SKILL.md endpoint table (added the two MCP rows).

## What was dropped / replaced

- **All PR migration artifacts** (`0060–0062`/`0065–0067` SQL + snapshot JSONs + journal entries).
  Cortex's migration journal is at `0110` and its Drizzle snapshot chain is **broken on master**
  (snapshots stop at `0098`; `0095` and `0098` both claim parent `8b20879c`; `0094`/`0097` missing),
  so `drizzle-kit generate` fails on the fork independent of this port. Following fork convention,
  the PR's three migrations were merged into one hand-written
  `packages/db/src/migrations/0111_mcp_server_registry.sql` (identical DDL) with a journal entry;
  `check:migrations` passes. **Follow-up (separate ticket): repair the snapshot chain** or Cortex
  permanently loses `drizzle-kit generate`.
- PR's rewrite of the SKILL.md endpoint table (Cortex's version is newer).

## Feature flag (added in the port; not in the PR)

The PR ships **unflagged**. The port adds `server/src/mcp-client-flag.ts`
(`PAPERCLIP_MCP_CLIENT_ENABLED === "true"`), gating:

- mounting of `mcpServerRoutes` in `app.ts` (off → routes don't exist, plain 404s);
- registration of the two `/agents/me/mcp-tools*` routes;
- the heartbeat MCP context injection (off → adapters receive no MCP context, so
  `buildPaperclipMcpPrompt` returns `""` — prompt byte-identical to before the port);
- UI: flag exposed as `features.mcpClientEnabled` on `/api/health`; the "MCP Servers" nav items
  (Sidebar, CompanySettingsSidebar) and the AgentDetail "MCP Servers" tab render only when on.

Not gated (deliberately, cosmetic only): the `mcpServers` placeholder/hint text on the existing
free-form workspace-runtime JSON textareas (Execution/Project workspace detail). Persisting
`mcpServers` there is inert while the flag is off. The `/company/settings/mcp-servers` client
route stays mounted but is unreachable via nav and its API calls 404 when off.

## Quality assessment & divergences to reconcile in D2-1..D2-8

1. **Hand-rolled `StdioJsonRpcClient`** (~250 lines in `services/mcp-servers.ts`: manual
   `Content-Length` framing, custom timeout/kill handling). Works for discovery but duplicates the
   official SDK. **D2-1/D2-3: replace with `@modelcontextprotocol/sdk` client transport.** The
   service's public surface (list/create/update/delete/test/discover, `listBindingsForAgent`) is a
   clean seam for the swap.
2. **stdio-first; http persisted but not executable.** `transport: "http"` rows can be stored;
   discovery/execution throws for them. **D2-3: implement http/sse via the SDK. D2-7: gate stdio**
   (arbitrary `command` execution on the control-plane host is a real security surface — currently
   board-only via `assertBoard`, but Cortex should decide whether stdio is allowed at all in
   production and behind what instance-level setting).
3. **Zero tests in the PR.** No unit tests for binding resolution, tool-name disambiguation,
   allowlists, or the JSON-RPC client. **D2-2 (or first task after base branch lands): add
   service-level tests**, minimum: `listForAgent` filtering (enabled/allowlist), `executeForRun`
   candidate resolution (ambiguous tool names), env-binding secret resolution.
4. **`executeForRun` ignores its run context.** The route fetches the heartbeat run only to 404,
   then passes just `agentId`; `workspacePath` is accepted and unused, and execution is not
   attributed to the run (no activity-log entry with `runId`). **D2-4/D2-5: thread run attribution
   and audit logging through execution.**
5. **Adapter coverage: 2 of 11.** Only `claude-local` and `codex-local` build the MCP prompt.
   Cortex also ships `acpx-local`, `gemini-local`, `grok-local`, `hermes-local`, `opencode-local`,
   `pi-local`, `cursor-local/cloud`, `openclaw-gateway`. **New task delta for D2-6: wire
   `buildPaperclipMcpPrompt` into the remaining adapters** (mechanical; same 4-line pattern).
6. **Catalog snapshots only grow.** Every discovery inserts a snapshot row; no retention/pruning.
   Low risk short-term; note for D2-8 (ops hardening).
7. **UI is monolithic but functional.** `CompanyMcpServers.tsx` at 803 lines will need splitting
   if we extend it, not a blocker.

## Verification performed

- `pnpm --filter <pkg> typecheck` green for: `shared`, `db` (incl. `check:migrations`),
  `adapter-claude-local`, `adapter-codex-local`, `server`, `ui`.
- `shared`, `adapter-utils`, `db` build green.
- `vitest run server/src/__tests__/health.test.ts` green (6/6) after the `/api/health`
  `features.mcpClientEnabled` addition.
- Flag-off runtime audit: all callers of `agentMcpTools.*` and all MCP context producers are
  inside `isMcpClientEnabled()` guards; service factories have no construction side effects.

## Concrete task deltas for D2-1..D2-8

- **D2-1 (SDK client):** unchanged, confirmed necessary (item 1).
- **D2-2:** add test suite for services (item 3) — new explicit scope.
- **D2-3 (http/sse):** unchanged (item 2); do it as part of the SDK swap.
- **D2-4/D2-5 (execution plumbing):** add run attribution + audit logging (item 4).
- **D2-6 (adapter rollout):** extend to the other 9 adapters (item 5) — bigger than planned.
- **D2-7 (stdio gating):** confirmed; decide instance-level policy for stdio commands (item 2).
- **D2-8 (ops):** add snapshot retention (item 6); repair the Drizzle snapshot chain (separate
  pre-existing fork issue surfaced by this port).
