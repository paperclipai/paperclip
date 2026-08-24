# Structural Audit — `fork/docs-deploy-voy-1413`

**Reviewer:** Staff Engineer
**Date:** 2026-08-19
**Base:** `efde596203` (Merge fork/master) → HEAD `2e90d0d5ae` (CEO heartbeat)
**Scope:** 6 files (+736 lines) across shared types, server routes/services, UI, and heartbeats

---

## Verdict: **BLOCKED** — P1 test integrity failure

The diff introduces tests that cannot pass against the current public API. This cannot ship until the tests are either fixed (export the missing symbols) or corrected (use relative imports).

---

## P1 Issues (Must Fix Before Shipping)

### P1.1 — Notification delivery test imports dead API

**File:** `packages/shared/src/__tests__/notification-delivery-status.test.ts:2-5`
**Severity:** Critical — whole test file is non-functional

The test imports `computeDeliveryStatus` and `DeliveryChannelStatus` from `@paperclipai/shared`:
```typescript
import {
  computeDeliveryStatus,       // value export — NOT re-exported from index.ts
  type DeliveryChannelStatus,  // type export — NOT re-exported from index.ts
} from "@paperclipai/shared";
```

`computeDeliveryStatus` is defined in `packages/shared/src/types/notifications.ts:122` and `DeliveryChannelStatus` is defined at `:19`. Neither is re-exported from `packages/shared/src/index.ts`. The index only exports a subset of notification types (`NotificationRecord`, `NotifyInput`, etc.) but not `DeliveryStatus`, `DeliveryChannelStatus`, or `computeDeliveryStatus`.

**Evidence:** Running the test confirms 8/8 tests in this file fail:
```
FAIL  |@paperclipai/shared| src/__tests__/notification-delivery-status.test.ts
  Tests  8 failed
  Error: computeDeliveryStatus is not a function
```

**Fix:** Either:
- (a) Add `computeDeliveryStatus`, `DeliveryStatus`, and `DeliveryChannelStatus` to the re-export block in `packages/shared/src/index.ts` (around line 1765), OR
- (b) Change the test imports to relative paths matching the sibling test pattern (`shared-telemetry-events.test.ts` uses `"../telemetry/events.js"` — that's the correct pattern for intra-package tests)

I recommend (b) since intra-package tests should use relative imports (consistent with `shared-telemetry-events.test.ts`), and only consumers should use `@paperclipai/shared`. However, if the function is meant to be public API, do both: export it and update the test import.

---

## P2 Issues (Fix Before Shipping)

### P2.1 — Duplicate title detection is pagination-limited

**File:** `server/src/services/knowledge-starter-packs.ts:108-109`
**Severity:** High — real data duplication bug under scale

The `installPack` method fetches existing documents to check for title duplicates:
```typescript
const existingDocs = await knowledgeSvc.list(companyId, { limit: 100 });
const existingTitles = new Set(existingDocs.items.map((d) => d.title.toLowerCase()));
```

The `knowledgeDocumentService.list()` caps at `MAX_LIST_LIMIT = 100` (`server/src/services/knowledge-documents.ts:163`). Any company with >100 knowledge documents will have undetected title collisions, creating duplicate starter pack documents.

**Fix:** Either remove the `limit` caps entirely for the dedup check (add a `listAll()` method or an uncapped internal query), or switch to a direct SQL dedup check (SELECT title WHERE companyId = ?) rather than loading all items into application memory.

---

## P3 Issues (Noteworthy — Address or Document Intent)

### P3.1 — GET endpoints expose full document bodies without auth

**Files:**
- `server/src/routes/knowledge-starter-packs.ts:26` (GET /knowledge-starter-packs)
- `server/src/routes/knowledge-starter-packs.ts:35` (GET /knowledge-starter-packs/:packKey)

Neither route requires authentication. Anyone who discovers the endpoint can read all starter pack content (including full document bodies on the `:packKey` detail endpoint).

Currently the data is generic (coding standards, CI/CD runbooks, etc.) — not proprietary. But this sets a precedent. If starter packs ever contain customer-specific templates or differentiated content, this is a data leak.

**Mitigation:** Either add auth guards or explicitly document in the route comments that this is intentionally public catalog content. If public, the GET-by-packKey endpoint should still consider omitting `body` from the list endpoint response (the route already claims "documents excluded" in the comment — good, but the detail endpoint returns everything).

### P3.2 — `installPack` in company-templates.ts omits actorAgentId

**File:** `server/src/services/company-templates.ts:304`
```typescript
await starterPacks.installPack(company.id, tmpl.starterPackKey);
```

No `actorAgentId` passed. Documents created via template initialization have no author attribution. This is fine as an explicit design choice for automated seed data, but it should be noted.

### P3.3 — `retry: false` on notification query (operator decision)

**File:** `ui/src/components/NotificationHistory.tsx:39`

The query has `retry: false`, meaning a transient network failure permanently shows an error state. For an operator-only utility this may be acceptable, but it diverges from the typical react-query default of 3 retries.

---

## Minor / Cosmetic

### P3.4 — Redundant `getPack` double-fetch

**File:** `server/src/routes/knowledge-starter-packs.ts:65` and `:74`
The install route pre-checks pack existence via `svc.getPack(packKey)`, then `svc.installPack(companyId, packKey, actorAgentId)` does `packs.find()` again internally. The service already throws a descriptive error on missing packs — the route check is redundant I/O for an in-memory data source. Harmless but unnecessary.

### P3.5 — Test mock fragility (maintainability)

**File:** `server/src/__tests__/knowledge-starter-packs-routes.test.ts`

The test uses `vi.doMock` with a `?ksp-N` cache-busting query parameter on dynamic imports. If anyone refactors import paths in the route or service modules, the mock will silently stop functioning and the test will execute against real DB code. This pattern works but is fragile — consider static `vi.mock` at the top level if possible.

---

## Summary

| ID | Severity | Area | Status |
|---|---|---|---|
| P1.1 | **Critical** | Shared test | **Must fix** — test imports dead API |
| P2.1 | **High** | Starter pack dedup | **Must fix** — paginated dedup misses duplicates |
| P3.1 | Medium | GET route auth | Address or document design intent |
| P3.2 | Low | Template author | Document intent |
| P3.3 | Low | UI query config | Note |
| P3.4 | Low | Route redundancy | Nit |
| P3.5 | Low | Test maintainability | Note |

**Bottom line:** P1.1 alone blocks shipping — the test file produces 8 failures that are invisible if CI skips running the file (or if CI only runs the server test suite). P2.1 is a structural data integrity issue that will become visible once companies pass 100 knowledge docs.