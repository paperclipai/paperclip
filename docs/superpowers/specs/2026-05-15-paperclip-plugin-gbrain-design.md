# paperclip-plugin-gbrain — design

Date: 2026-05-15
Status: Design approved, pending implementation plan

## Motivation

gbrain (the gstack graph-brain / personal knowledge graph) is already exposed
to paperclip agents via MCP — `gbrain-mcp` service in the `paperclip`
namespace serves Streamable HTTP MCP at `http://gbrain-mcp.paperclip.svc.cluster.local:3131/gbrain`,
and paperclip-server's seeded `mcp.json` baseline points agents there. So
agents can already call gbrain tools (search, query, put_page, add_link, …)
directly.

What MCP cannot do is react to agent lifecycle events. The
`@vectorize-io/hindsight-paperclip` plugin already demonstrates the pattern:
auto-recall relevant context at `agent.run.started`, auto-retain run output
at `agent.run.finished`. This spec applies that same pattern to gbrain, with
two important differences:

1. **Identity binding**: every write to gbrain carries
   `metadata.{agentId, runId, companyId}` so the shared cluster brain can be
   filtered by "what did the CTO contribute" or "timeline of BLO-3220".
2. **Dual-write alongside hindsight**: same lifecycle events drive writes to
   both stores. Hindsight does fuzzy semantic recall over embedded memory
   units; gbrain does structured graph traversal over typed pages and links.
   The two are complementary, not competitive.

## Architecture

```
Agent run lifecycle in paperclip-server
            │
            ├── agent.run.started ──→ gbrain plugin
            │                              │
            │                              ↓
            │                       traverse_graph(issuePage, depth=2)
            │                              │
            │                              ↓
            │                       store result in run state for
            │                       gbrain_recall_cache tool readback
            │
            └── agent.run.finished ──→ gbrain plugin
                                         │
                                         ├─ sync path:
                                         │   ensureIssuePage(identifier)
                                         │   ensureAgentPage(agentId)
                                         │   add_link(agent → issue, worked_on)
                                         │   add_timeline_entry(issue page,
                                         │     body=stdoutExcerpt, agentId,
                                         │     runId, outcome, finishedAt)
                                         │
                                         └─ deferred (3min, ctx.jobs):
                                             query hindsight for memory_units
                                               where metadata.runId = <runId>
                                             for each unit without
                                                 metadata.gbrainPageSlug:
                                               put_page(slug=fact/<uuid>,
                                                       type=fact,
                                                       content=unit.text)
                                               add_link(issue → fact, mentions)
                                               add_link(agent → fact, authored_by)
                                               PATCH unit.metadata.gbrainPageSlug
```

### Transport

Plugin → `http://gbrain-mcp.paperclip.svc.cluster.local:3131/gbrain` (in-cluster
MCP, no auth, no token rotation).

MCP is JSON-RPC over Streamable HTTP. Hand-rolled minimal client (~50 lines):
`initialize` once on plugin startup, then `tools/call` per operation. No need
for the full MCP SDK — we own both ends and never need streaming or
subscriptions.

### Page conventions

| Slug pattern | Type | Created by |
|---|---|---|
| `issue/<identifier>` | `issue` | `ensureIssuePage` on first run on that issue |
| `agent/<agentSlug>` | `agent` | `ensureAgentPage` on first run by that agent |
| `fact/<memoryUnitUuid>` | `fact` | fact-promotion job after hindsight consolidates |

`<identifier>` is `context_snapshot.paperclipIssue.identifier` (e.g.
`BLO-3220`, `PCL-1490`). For cross-company collision avoidance the
implementation MAY prefix with `<companyId>::` — open question, see §9.

`<agentSlug>` is derived from agent name: lowercase, drop non-alphanumeric
(e.g. CTO → `cto`, MulticastEngineer → `multicastengineer`). Pure function
in `identity.ts`.

### Link conventions

| From | To | Link type |
|---|---|---|
| `agent/*` | `issue/*` | `worked_on` |
| `issue/*` | `fact/*` | `mentions` |
| `agent/*` | `fact/*` | `authored_by` |

## Components

```
packages/plugins/paperclip-plugin-gbrain/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── worker.ts           # definePlugin + runWorker entrypoint
│   ├── manifest.ts         # name, version, config schema
│   ├── gbrain-client.ts    # MCP-over-HTTP JSON-RPC client
│   ├── pages.ts            # slug derivation + ensure-page helpers
│   ├── handlers.ts         # lifecycle event handlers
│   ├── fact-promotion.ts   # deferred hindsight→gbrain sweep job
│   └── identity.ts         # agent slug derivation
└── dist/
```

Each unit has one clear purpose, communicates via a typed interface, and is
testable independently:

- **`gbrain-client.ts`** — only knows MCP transport. `call(tool, args) → result`.
  No business logic. Swap to a different transport without touching anything
  else.
- **`pages.ts`** — only knows gbrain page conventions. Pure helpers that
  take a `gbrain-client` and produce slug-aware idempotent writes. No HTTP
  knowledge directly.
- **`handlers.ts`** — wires lifecycle events to `pages.ts` helpers. No
  awareness of transport.
- **`fact-promotion.ts`** — pulls memory_units from hindsight, calls
  `pages.ts` helpers, stamps idempotency markers. Owns the hindsight client
  too (a separate `HindsightClient`, or reuse the one already in
  `@vectorize-io/hindsight-paperclip` if vendored).
- **`identity.ts`** — pure derivation: agentId → slug. No I/O.

## Config (manifest.ts)

```ts
{
  gbrainMcpUrl: { type: "string",
    default: "http://gbrain-mcp.paperclip.svc.cluster.local:3131/gbrain" },
  hindsightApiUrl: { type: "string",
    default: "http://hindsight-api.hindsight.svc.cluster.local:8888" },
  autoRecall: { type: "boolean", default: true },
  autoRetain: { type: "boolean", default: true },
  promoteFactsToPages: { type: "boolean", default: true },
  recallTraversalDepth: { type: "integer", default: 2 },
  factPromotionDelaySec: { type: "integer", default: 180 }
}
```

No secret refs in v1. If external gbrain access is ever needed (across
clusters, multi-tenant gbrain, etc.), add `gbrainApiKeyRef: { type: "string" }`
and a bearer header in `gbrain-client.ts` — non-invasive.

## Error handling & idempotency

- **MCP timeouts**: every call wrapped with 15s `AbortController`. On timeout,
  `ctx.logger.warn` and return; never throw. The plugin must not break agent
  run lifecycle.
- **Page idempotency**: `ensureIssuePage` does `get_page(slug)` first; only
  calls `put_page` if missing. `put_page` is itself slug-keyed and idempotent
  in gbrain.
- **Timeline idempotency**: each `add_timeline_entry` carries
  `metadata.runId`. The implementation MAY check for an existing entry with
  that runId before inserting; current gbrain `add_timeline_entry` is
  append-only so duplicate-on-replay is possible but bounded.
- **Fact-promotion idempotency**: after promoting a memory_unit to a fact
  page, PATCH `memory_units.metadata.gbrainPageSlug = 'fact/<uuid>'` via
  hindsight API. Re-sweep skips units that already have it.
- **Pod restart mid-sweep**: deferred jobs are persisted in paperclip's
  `agent_async_jobs` table by the SDK. After restart, the job manager
  re-fires unfinished promotion sweeps; the idempotency stamp prevents
  double-writes.
- **gbrain down**: every call in a try/catch with `ctx.logger.warn`. Plugin
  never blocks a run.

## Testing

### Unit (vitest, no network)
- `gbrain-client.test.ts` — mock `fetch`, assert correct JSON-RPC envelope
  for `initialize` and `tools/call`. Verify 15s timeout fires.
- `pages.test.ts` — slug derivation rules; `ensureIssuePage` calls `get_page`
  then conditionally `put_page`.
- `identity.test.ts` — agent name → slug edge cases (special chars,
  collisions).
- `fact-promotion.test.ts` — given a mock hindsight response with N units,
  assert N `put_page` + 2N `add_link` calls in the right order, and that
  units already stamped are skipped.

### Integration (against ephemeral gbrain)
- Spin up gbrain in test mode (PGLite), publish a fake `agent.run.finished`
  event via the plugin event bus, assert timeline_entry shows up via
  `get_page` + scan.
- Gated on `GBRAIN_TEST_URL` env to allow CI skip when gbrain isn't
  available.

### Manual verification post-deploy
- Trigger a test run; open `kubectl -n paperclip port-forward
  svc/gbrain-mcp-admin 3130:3130` → http://localhost:3130/admin; confirm
  issue page exists with the expected timeline entry.
- Wait 5min, confirm fact pages appear under `fact/<uuid>` with links from
  the issue page.

## Scope & non-goals

### In scope (v1)
- Auto-recall via `traverse_graph` on run start, depth=2, cached in run state
- Sync auto-retain timeline_entry on run finish
- Deferred fact-promotion: memory_units → fact pages with typed links
- Identity binding via `metadata.{agentId, runId, companyId}` on every write
- Ensure-page semantics for issue / agent pages

### Explicitly out of scope (v1)
- ❌ Custom paperclip tool surface (`gbrain_search`, etc.) — agents already
  call gbrain MCP tools directly via the seeded `mcp.json` baseline; a
  re-exposure layer would be redundant. The one concession: a single
  `gbrain_recall_cache` tool to surface the pre-fetched traversal result —
  see §9.
- ❌ Per-agent gbrain slicing / scoping — single shared brain is fine;
  metadata-tagged writes are queryable post-hoc.
- ❌ Multi-brain support — one cluster gbrain instance.
- ❌ External-access auth path (`pcp_*` tokens) — in-cluster URL only.
- ❌ Source-document ingestion (gbrain has `sources_add` / job-based crawl)
  — outside agent-lifecycle scope.
- ❌ Real-time fact promotion — 3min wait for hindsight consolidation is the
  acknowledged tradeoff of the hybrid write shape.

## Build & deploy sequencing

The plugin lands in two waves; wave 2 depends on wave 1 being live and
healthy.

### Wave 1 — plugin scaffold + sync auto-retain
1. Create `packages/plugins/paperclip-plugin-gbrain/` with manifest, worker,
   gbrain-client, pages, handlers (timeline_entry only, no fact promotion).
2. Register in the kkroo-fork image plugin store (Dockerfile already
   enumerates plugins; add this one to the list).
3. Add config + enable in `plugin_company_settings` for Blockcast.
4. Deploy via PR → master merge → image build → helm bump → rollout.
5. Verify: trigger a test run, see timeline_entry in gbrain via `/admin` UI.

### Wave 2 — auto-recall + deferred fact-promotion
1. Add `traverse_graph` call in `agent.run.started` handler; store in run
   state.
2. If §9 lands on the tool-surface variant: register
   `gbrain_recall_cache` paperclip tool that reads from run state.
3. Add fact-promotion job (3min defer, hindsight query, page+link writes,
   idempotency stamp).
4. Wire into plugin's job registry via `ctx.jobs.schedule` (or the SDK's
   equivalent — see §9).
5. Deploy via second PR.

Wave 1 is the high-value, low-risk slice. Wave 2 adds graph-traversal recall
and the fact-graph but needs deeper integration testing. If wave 1 reveals
gbrain reliability issues, wave 2 can adjust.

## Open questions (resolve during plan phase)

1. **Run-context injection mechanism.** hindsight uses
   `ctx.state.set({scopeKind:"run", ..., stateKey:"recalled-memories"})` and
   the agent reads via the `hindsight_recall` paperclip tool. For gbrain we
   chose no tool surface — so we need either (a) a single
   `gbrain_recall_cache` tool that reads the cached traversal (small
   concession to scope, very narrow tool), or (b) a SDK primitive for direct
   pre-run context injection if one exists. The plan needs to confirm
   which.

2. **Plugin deferred-job primitive.** The plugin-loader log shows
   `jobs:0` for hindsight, meaning the slot exists but isn't used by any
   shipping plugin yet. The plan needs to confirm `ctx.jobs.schedule(name,
   delayMs, payload)` exists in `@paperclipai/plugin-sdk` and works. If
   not, fall back to a paperclip-server cron or a self-scheduled in-process
   timer (lower durability across restarts).

3. **Page-slug collisions across companies.** Two issues across companies
   could share identifier `BLO-3220`. Use `<companyId>::issue/<id>` slug
   format? Verify against gbrain's slug normalization rules — slugs may not
   allow `::` literally. Alternative: namespace via gbrain `tag` field
   instead of slug.

4. **Hindsight `metadata.runId` filter query**. Hindsight exposes
   `/v1/{instance}/banks/{bank}/memories` but the query-by-metadata path is
   not documented in the worker code I read. The plan needs to confirm the
   right API call, or query hindsight's postgres directly (less coupled but
   more invasive).

5. **Failure-mode runs**. We subscribe to `agent.run.finished` (status =
   `succeeded`). Should `agent.run.failed` / `agent.run.cancelled` also
   write timeline entries? Probably yes for the failed case ("agent X tried
   and failed at this step") — confirm scope.

## References

- `@vectorize-io/hindsight-paperclip@0.2.0` — the design template
  (`/paperclip/.paperclip/plugins/node_modules/@vectorize-io/hindsight-paperclip/dist/worker.js`)
- `~/k8s/paperclip/gbrain-mcp.yaml` — deployment + transport details
- PR #14 — server-side payload enrichment (issueTitle, issueDescription,
  output, result on `agent.run.*` events) required for both the hindsight
  and gbrain plugin retain paths
- Existing kkroo fork plugin patterns: `paperclip-plugin-ccrotate`,
  `paperclip-plugin-linear`, `paperclip-plugin-slack`
- Slack plugin design precedent at
  `docs/superpowers/specs/2026-04-27-paperclip-plugin-slack-fork-design.md`
