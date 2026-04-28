# Pitfalls Research

**Domain:** Adding wikiLLM/Graphify knowledge graph ingest cycle + coin_ledger ACID integrity to existing RealTycoon2 app
**Researched:** 2026-04-27
**Confidence:** MEDIUM-HIGH

---

## Critical Pitfalls

### Pitfall 1: Graph Edge Confidence Tagging — EXTRACTED/INFERRED Leakage

**What goes wrong:**
Imported Obsidian wikilinks and inferred relationships are incorrectly tagged as `EXTRACTED` instead of `AMBIGUOUS`, polluting graph confidence signals. The graph reports show inflated EXTRACTED counts, misleading downstream quality evaluation.

**Why it happens:**
During vault import, `buildImportPreviewCandidates` marks vault wikilinks as `AMBIGUOUS` with warnings, but when `applyObsidianVaultImport` creates graph edges from those wikilinks, the confidence is hardcoded to `"AMBIGUOUS"` — which is correct. However, the `upsertEdge` function used in `projectGraphEvent` defaults all edges to `EXTRACTED` with `confidenceScore: "1.00"`. Any code path that calls `upsertEdge` for inferred relationships will emit false EXTRACTED edges. Phase 5's threat model explicitly called this out, but implementation doesn't enforce it at the call site.

**How to avoid:**
Add an optional `confidence` parameter to `upsertEdge`. When called from `projectGraphEvent`, always pass `EXTRACTED`. When called from import/resolution paths that handle operator-supplied content, pass the appropriate confidence (`AMBIGUOUS` for wikilinks, `INFERRED` for LLM-inferred edges). Add a lint rule or runtime assertion: edges with `source: "obsidian_vault_import"` must have confidence `AMBIGUOUS`.

**Warning signs:**
- Graph report confidence summary shows EXTRACTED count climbing without corresponding domain events
- `rt2V33GraphEdges` has edges with `sourceNodeId` pointing to `vault_page:*` nodes but confidence = `EXTRACTED`
- Phase 5 tests pass but confidence assertions are missing from test suite

**Phase to address:**
Dedicated ingest/lint phase (before full Obsidian sync). Prevention: unit test asserting imported edges are AMBIGUOUS.

---

### Pitfall 2: Coin Ledger `balanceAfter` — Stale Read Race Condition

**What goes wrong:**
`recordCoinTransaction` reads the current balance with `getActorBalance`, then inserts the new entry with `balanceAfter = currentBalance + amount`. Between the read and the insert, another transaction can modify the balance, causing:
1. Two concurrent earnings both compute `balanceAfter` from the same stale snapshot
2. The ledger entry shows incorrect balance for one or both transactions
3. P&L aggregation (sum of ledger amounts) still matches, but `balanceAfter` is inconsistent with actual cumulative balance

**Why it happens:**
The pattern in `rt2-personal-pnl.ts` lines 354-358 is non-atomic:
```typescript
const currentBalance = await getActorBalance(companyId, toActorId, toActorType);
const balanceAfter = currentBalance + amount;
await db.insert(rt2CoinLedger).values({ ..., balanceAfter });
```
This is a classic read-then-write race. The code doesn't use `SELECT ... FOR UPDATE` or atomic upsert.

**How to avoid:**
Calculate `balanceAfter` using a single atomic SQL expression at insert time:
```sql
INSERT INTO rt2_coin_ledger (..., balanceAfter)
SELECT ..., (COALESCE(SUM(amount), 0) + $amount) FROM rt2_coin_ledger
  WHERE company_id = $companyId AND to_actor_id = $actorId AND to_actor_type = $actorType
```
Or use Drizzle's `.returning()` with a raw SQL subquery. Alternatively, store `balanceAfter` as `null` initially and compute it on read via `SUM(amount) OVER (ORDER BY createdAt)`.

**Warning signs:**
- Concurrent settlement approvals for the same actor produce duplicate ledger entries with identical `balanceAfter` values
- `balanceAfter` in ledger doesn't match `SUM(amount) GROUP BY (toActorId, toActorType)` by more than 1%
- Reconciliation query shows gaps in running balance sequence

**Phase to address:**
Ledger atomicity phase. Prevention: add concurrent-approval stress test.

---

### Pitfall 3: Graph Refresh — Full Scan on Every Event

**What goes wrong:**
`refreshGraphReport` (called at the end of every `projectGraphEvent`) executes two full scans: `SELECT * FROM rt2_v33_graph_nodes WHERE companyId = $X AND projectId = $Y` and the same for edges. At 100+ events per company, this means O(n²) database reads during normal operation. The projector runs synchronously in `appendAndProject`, so event append latency grows quadratically.

**Why it happens:**
`projectGraphEvent` is called for each domain event. It calls `refreshGraphReport` at the end. The graph report is an aggregation that could be maintained incrementally.

**How to avoid:**
Remove `refreshGraphReport` from the per-event path. Compute graph reports on read (lazy materialization) or on a schedule (batch). Store node/edge counts as counters updated incrementally in `upsertNode`/`upsertEdge`. Only recompute the full markdown report when requested or on demand.

**Warning signs:**
- Event append latency increases noticeably after 50+ events for a company
- `refreshGraphReport` appears in slow query logs (>50ms)
- `appendAndProject` is on the critical path for every work operation

**Phase to address:**
Graph projection performance phase. Prevention: add timing assertions to projector tests.

---

### Pitfall 4: Settlement Governance — Double Materialization of P&L Entries

**What goes wrong:**
`materializeApprovedDeliverablePnL` and `ensureSettlementRows` both iterate over approved deliverables and create entries if they don't exist. When called before `getSettlementOverview` or `getCompanyPnLSummary`, both call these materialization functions. If called concurrently (e.g., two API requests), duplicate ledger entries or settlement rows are created because the existence check is not atomic with the insert.

**Why it happens:**
In `rt2-personal-pnl.ts` lines 576-606, `materializeApprovedDeliverablePnL` does:
```typescript
const existingLedger = await db.select().from(rt2CoinLedger).where(...).limit(1);
if (existingLedger.length > 0) continue;
await recordIncome(...);
```
And in `ensureSettlementRows` lines 701-761, same pattern with `rt2SettlementGovernance`. Between the check and the insert, another call can pass the check.

**How to avoid:**
Use database-level unique constraints as the source of truth. Add unique index on `rt2CoinLedger.referenceId` for `approved_deliverable` reference type (already implied by schema intent). For settlements, use `ON CONFLICT DO NOTHING` on the governance insert. Wrap materialization in a transaction with `SERIALIZABLE` isolation for the duration of the existence check + insert.

**Warning signs:**
- `rt2CoinLedger` shows duplicate entries for same `workProductId` with different `createdAt`
- Settlement overview summary counts don't match actual ledger entry sums
- Reconciliation fails with "expected N entries but found N+M"

**Phase to address:**
Settlement flow atomicity phase. Prevention: add uniqueness constraints and concurrent stress test.

---

### Pitfall 5: Wiki Page Rebuild — `sourceEventIds` Accumulation Without Deduplication

**What goes wrong:**
`upsertWikiPage` replaces the page content but always appends new event IDs to `sourceEventIds`. If a task is updated multiple times, the topic page accumulates all historical event IDs, making the source attribution grow unbounded. After 1000 events, wiki pages become slow to render and export.

**Why it happens:**
In `projectWikiForCompany`, each call to `upsertWikiPage` replaces `sourceEventIds` with the full list from `topicEvents.filter(...)`. Since `topicEvents` is filtered fresh from all events each time, this should be correct. But the `renderTopic` function generates markdown from all events, and the index/log pages accumulate ALL event IDs. At scale this becomes a large JSON array.

**How to avoid:**
Store `sourceEventIds` as a bounded array (last N event IDs, e.g., last 100) and track `totalEventCount` separately. Or store event IDs in a separate join table and query them on demand. For the MVP, set a practical limit (e.g., 500 event IDs max per page) and paginate.

**Warning signs:**
- Wiki page size exceeds 1MB in the database
- Frontmatter `rt2_source_event_ids:` block exceeds 50 lines
- `rt2_v33_wiki_pages.sourceEventIds` column type is JSONB array with >1000 elements

**Phase to address:**
Wiki scalability phase (defer if company has <1000 total events). Prevention: monitor `sourceEventIds` array length in monitoring.

---

### Pitfall 6: Knowledge Sync Conflict — RT2 vs Vault Timestamp Misresolution

**What goes wrong:**
`previewObsidianVaultImport` detects timestamp conflicts correctly, but `resolveObsidianVaultConflict` can silently discard operator decisions. If the conflict resolution is "vault_wins" but the operator made a manual merge, and the RT2 page was subsequently updated by a new domain event between conflict detection and resolution, the resolution overwrites the manual merge with the vault content.

**Why it happens:**
The conflict resolution flow doesn't take a current snapshot of the RT2 page at resolution time. It only stores `beforeState` from when the conflict was first detected. If events arrived in between, those updates are lost.

**How to avoid:**
Capture current RT2 page state at resolution time as `beforeState`, not at detection time. Compare timestamps: if the vault file's `rt2_updated_at` is older than the RT2 page's `updatedAt`, warn that the vault file is stale and require explicit operator confirmation to overwrite.

**Warning signs:**
- After vault sync, topic pages show fewer events than before
- `rt2_knowledge_sync_decisions` shows `decision: "vault_wins"` but RT2 wiki page has more recent content than the vault file
- Users report changes made in RT2 disappearing after Obsidian sync

**Phase to address:**
Bidirectional sync conflict resolution phase (Phase 21 area). Prevention: add timestamp freshness check.

---

### Pitfall 7: Coin Ledger Reconciliation — PersonalPnL vs CoinLedger Divergence

**What goes wrong:**
`rt2PersonalPnL` is updated by `recordIncome`/`recordExpense`, while `rt2CoinLedger` is updated by `recordCoinTransaction`. These are written in sequence but not in a single atomic transaction. If `recordIncome` succeeds but `recordCoinTransaction` fails (or vice versa), the P&L shows income but no corresponding ledger entry, or vice versa. The audit trail becomes inconsistent.

**Why it happens:**
In `recordIncome` (lines 246-283), the P&L update and ledger insert are two separate awaits. No transaction wrapper. Same in `recordExpense` and `transferCoins`. The `approveSettlement` function (lines 800-841) calls `recordIncome` and then updates the settlement row — also non-atomic.

**How to avoid:**
Wrap each income/expense pair in a database transaction:
```typescript
await db.transaction(async (tx) => {
  await tx.update(rt2PersonalPnL).set({ ... }).where(...);
  await tx.insert(rt2CoinLedger).values({ ... });
});
```
Or, make the ledger the authoritative source and derive P&L figures from it via a materialized view or on-demand query.

**Warning signs:**
- `rt2PersonalPnL.netPnL` doesn't equal `SUM(income) - SUM(expenses)` from `rt2CoinLedger`
- Settlement approved but ledger entry has no corresponding P&L update
- Monthly reconciliation query shows discrepancies

**Phase to address:**
Ledger-P&L consistency phase. Prevention: add reconciliation query that compares P&L sums vs ledger sums and fails if divergence > 0.

---

### Pitfall 8: Ingest Pipeline — Projector Idempotency Gap on Partial Failure

**What goes wrong:**
`processEvent` in `rt2-domain-events.ts` marks an event as `processed` BEFORE running the projector handler. If the projector handler throws after some but not all side effects (e.g., wiki page upserted but graph edge insert fails), the event is already marked `processed`. On retry, the wiki page is rewritten but the graph edge is still missing, creating inconsistent state.

**Why it happens:**
The flow is:
1. Insert `rt2ProjectorEvents.status = "processed"` (line 185-194)
2. If handler throws, the same row is updated to "failed"
3. On next call, `processEvent` sees "processed" and skips — but partial side effects persist

**How to avoid:**
Use the transactional outbox pattern: record the projector event status change and handler effects in the same transaction, or use a savepoint within `processEvent`. Better: make `projectGraphEvent` fully idempotent via upserts (it already does), but verify that `projectWikiForCompany` is also idempotent (it does via `onConflictDoUpdate`). The real risk is if any future projector operation uses non-idempotent writes. Add a test that simulates handler failure mid-execution and verifies no inconsistent state.

**Warning signs:**
- Graph nodes exist for an entity but no edges (orphan nodes)
- Wiki page exists for a company but graph report shows stale node count
- `rt2ProjectorEvents.status = "failed"` but some materializations succeeded

**Phase to address:**
Projector atomicity phase. Prevention: idempotency tests for all projector operations.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip unique constraint on `rt2CoinLedger.referenceId` for duplicate detection | Faster initial migration | Duplicate ledger entries from concurrent materialization; corrupted audit trail | Never (hard constraint needed) |
| Full graph report scan per event | Simpler code | O(n²) projector latency; blocks event append at scale | MVP only, must fix before 100 events/company |
| `balanceAfter` computed client-side (read-then-write) | Simpler transaction logic | Race conditions; ledger/balance inconsistency | Never (must be atomic or computed-on-read) |
| `sourceEventIds` as unbounded array | No pagination logic needed | Memory bloat; slow exports | Only if company is confirmed to have <500 total events |
| No transaction wrapping in income/expense recording | Faster initial implementation | P&L/ledger divergence under failures | Never |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|-------------------|
| RT2 event stream → knowledge projector | Adding projector logic inside `appendAndProject` creates synchronous coupling | Keep projector calls async; `appendAndProject` should not block on projector completion |
| Obsidian vault → RT2 wiki | Treating vault import as write path rather than read-only preview + explicit apply | Always dry-run first; require operator approval for each import candidate |
| Settlement approval → ledger | Creating ledger entry before settlement row is committed | Order: update settlement status → insert ledger entry → commit; use transaction |
| Domain events → graph edges | Emitting INFERRED edges from non-LLM paths (e.g., task→todo link inference) as EXTRACTED | Only domain event evidence = EXTRACTED; LLM inference = INFERRED; operator-supplied = AMBIGUOUS |
| P&L service → coin ledger | Calling `recordIncome` without checking if deliverable already settled | Check `existingLedger` before materializing; add unique constraint on reference |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Full graph report per event | Event append >200ms for companies with 50+ events | Lazy report computation; incremental counters | At ~50 domain events per company per day |
| Wiki page rebuild on every event | Memory growth proportional to event count | Store event window (last N); separate totalEventCount counter | At ~500 total events per company |
| Concurrent materialization scans | DB CPU spike on settlement overview | Add unique constraints; use `ON CONFLICT DO NOTHING` | At ~10 concurrent users triggering settlement flow |
| Vault export with large file count | Timeout generating vault export | Paginate export; async export job | At >500 wiki pages |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Graph edges without company scope | Company A's knowledge graph leaks into Company B | All graph queries must filter by `companyId`; add DB-level FK to companies table |
| Imported wikilinks auto-tagged as EXTRACTED | Operator can inflate graph quality signal without evidence | Imported content = AMBIGUOUS by default; requires explicit validation |
| Settlement approval without ledger audit | Manager approves settlement but no ledger entry created | Enforce ledger entry creation in same transaction as settlement approval |
| `balanceAfter` readable by any actor | Actor can read other actors' balances | Ledger routes must check actor identity or admin role |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Settlement shows "approved" but no gold awarded | User confusion; support tickets | Show ledger entry ID in settlement approval confirmation |
| Graph shows AMBIGUOUS edges without explanation | User doesn't know what to do | Show AMBIGUOUS edges with different visual treatment + tooltip explaining "needs operator validation" |
| Wiki export generates large vault | User's Obsidian becomes slow | Warn if export >50 files; offer filtered export |
| Concurrent settlement race shows duplicate | User sees duplicate settlement entries | Disable submit button after first click; optimistic UI with conflict detection |

---

## "Looks Done But Isn't" Checklist

- [ ] **wikiLLM ingest:** Often missing — edge confidence assertion (verify imported edges are AMBIGUOUS, not EXTRACTED). Check: `SELECT edge_type, confidence FROM rt2_v33_graph_edges WHERE source_node_id LIKE 'vault_page:%' AND confidence = 'EXTRACTED'` returns 0 rows.
- [ ] **coin_ledger:** Often missing — atomic `balanceAfter` calculation. Verify: concurrent inserts for same actor produce distinct `balanceAfter` values.
- [ ] **Graph projector:** Often missing — full-scan refresh. Verify: `refreshGraphReport` is NOT called inside `projectGraphEvent`. Check by timing 100 event projections.
- [ ] **Settlement materialization:** Often missing — duplicate detection. Verify: unique constraint on `(companyId, workProductId)` in settlement governance.
- [ ] **Ledger-P&L consistency:** Often missing — reconciliation query. Verify: `rt2PersonalPnL.income` equals `SUM(amount) FROM rt2CoinLedger WHERE toActorId = X AND transactionType = 'earned'`.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| EXTRACTED leakage | MEDIUM | Run `UPDATE rt2_v33_graph_edges SET confidence = 'AMBIGUOUS' WHERE source LIKE 'vault_page:%'`; rebuild graph reports |
| balanceAfter race | HIGH | Delete duplicate ledger entries (keep the latest); recalculate balanceAfter from SUM; investigate affected actors |
| Graph full-scan | LOW | Disable `refreshGraphReport` in projector path; add caching; only rebuild report on read |
| Double materialization | MEDIUM | Delete duplicate ledger entries where `referenceId` duplicates; add unique constraint; rerun materialization |
| sourceEventIds bloat | LOW | Add migration to truncate to last 500 IDs; add monitoring alert on array length |
| Conflict resolution data loss | HIGH | Restore from `rt2_knowledge_sync_decisions.beforeState`; re-apply operator decision; add timestamp check |
| P&L/ledger divergence | HIGH | Write reconciliation script to recompute P&L from ledger sums; patch P&L records; investigate transaction failures |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| EXTRACTED/INFERRED leakage | wikiLLM ingest + lint cycle | Unit test: imported edges = AMBIGUOUS |
| balanceAfter race | Ledger atomicity | Concurrent stress test: distinct balanceAfter |
| Graph full-scan per event | Graph projection performance | Timing assertion: 100 events < 2s |
| Double materialization | Settlement atomicity | Unique constraint + concurrent stress test |
| sourceEventIds bloat | Wiki scalability | Monitor array length <500 |
| Conflict resolution data loss | Bidirectional sync hardening | Timestamp freshness check before overwrite |
| P&L/ledger divergence | Ledger-P&L consistency | Reconciliation query: P&L == ledger SUM |
| Projector idempotency gap | Projector atomicity | Inject failure mid-execution; verify consistency |

---

## Sources

- Phase 5 PLAN.md threat model (explicitly called out EXTRACTED edge discipline)
- Phase 22 settlement governance implementation (rt2-personal-pnl.ts recordCoinTransaction pattern)
- rt2-knowledge-projector.ts upsertEdge (hardcoded EXTRACTED)
- rt2-v33_graph_projection.ts schema (confidence field with EXTRACTED/INFERRED/AMBIGUOUS)
- rt2_personal_pnl.ts and rt2_settlement_governance.ts patterns (non-atomic read-then-write)
- Phase 5 threat model: "Inferred edge misuse: first pass should only emit EXTRACTED edges unless confidence/evidence is explicit"
- Projector processEvent implementation (processed-before-handler pattern)

---

*Pitfalls research for: wikiLLM/Graphify ingest cycle + coin_ledger ACID integrity*
*Researched: 2026-04-27*
