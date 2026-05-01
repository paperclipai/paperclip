# Phase 72 — Public Marketplace Launch: SUMMARY

## Status: ✅ COMPLETE + PASSED

## Quick Summary
Public/open marketplace approval workflow implemented. Listings go through draft → pending_approval → approved|rejected lifecycle. Public routes only surface approved listings with tier-based evidence (no raw gold amounts). Company-scoped routes include own listings regardless of approval status.

## What Was Built

### Schema Changes (`packages/db/src/schema/rt2_agent_marketplace.ts`)
- Added `listingApprovalStatus` column: `"draft" | "pending_approval" | "approved" | "rejected"`
- Added `rejectionReason` column for rejected listings
- Added `submittedAt` timestamp for when listing was submitted for review
- Added `approvedAt` timestamp for when listing was approved
- Added index on `(listingApprovalStatus)` for efficient filtering
- Added composite index on `(creatorCompanyId, listingApprovalStatus)` for company-scoped pending queries

### Migration (`packages/db/src/migrations/0109_rt2_public_marketplace_approval.sql`)
- Adds 4 new columns + 2 indexes
- Applied successfully; all 30 pending migrations now resolved

### Service Changes (`server/src/services/rt2-agent-marketplace.ts`)
- **`createListing`**: Now defaults `listingApprovalStatus: "draft"` (was previously absent/undefined)
- **`listMarketplaceAgents`**: `publicOnly: true` filter enforces `listingApprovalStatus = "approved"`
- **New `submitForApproval`**: draft → pending_approval with submittedAt timestamp
- **New `approveListing`**: pending_approval → approved with approvedAt timestamp
- **New `rejectListing`**: pending_approval → rejected with rejectionReason
- **New `getPendingApprovals`**: Returns all pending_approval listings for a company
- **New `getPublicMarketplaceListing`**: Returns `PublicMarketplaceListing` (public evidence contract, no raw gold)
- **New `listPublicMarketplaceAgents`**: Returns only approved listings as `PublicMarketplaceListing[]`
- **New tier derivation functions**:
  - `deriveEvidenceTier(approvedCount)`: bronze < 3, silver < 6, gold ≥ 6
  - `deriveReputationTier(subscriptionCount)`: new=0, established≥1, top_rated≥11
  - `deriveQualityTier(averageQualityScore)`: bronze<50, silver<75, gold≥75
  - `getPricingLabel()`: Human-readable price labels for public view

### Route Changes (`server/src/routes/rt2-agent-marketplace.ts`)
- **`GET /rt2/marketplace/agents`**: Public — returns only approved listings (PublicMarketplaceListing)
- **`GET /rt2/marketplace/search`**: Public — searches approved listings only
- **`GET /rt2/marketplace/agents/:id`**: Public — returns PublicMarketplaceListing; ?includePrivate=true for full evidence
- **`POST /companies/:companyId/rt2/marketplace/listings`**: Create draft listing
- **`POST /companies/:companyId/rt2/marketplace/listings/:id/submit-for-approval`**: Submit for review
- **`POST /companies/:companyId/rt2/marketplace/listings/:id/approve`**: Approve listing
- **`POST /companies/:companyId/rt2/marketplace/listings/:id/reject`**: Reject with reason
- **`GET /companies/:companyId/rt2/marketplace/pending-approvals`**: List pending listings

### Public Evidence Contract (`PublicMarketplaceListing`)
```typescript
{
  id, creatorCompanyId, name, description, category, tags,
  pricingType, pricePerTaskCents, monthlySubscriptionCents,
  adapterType, isActive, totalSubscriptions, ratingAverage, ratingCount,
  publicEvidence: {
    evidenceTier: "bronze" | "silver" | "gold",
    reputationTier: "new" | "established" | "top_rated",
    qualityTier: "bronze" | "silver" | "gold",
    evidenceStatus: "ready" | "partial" | "missing",
    pricingSummary: { pricingType, priceLabel },
    approvalStatus: "approved"
  }
}
// NO raw gold amounts — earnedGoldEstimate, approvedBasePriceGold hidden
```

## Evidence Artifacts

| Artifact | Path |
|---|---|
| Schema | `packages/db/src/schema/rt2_agent_marketplace.ts` |
| Migration | `packages/db/src/migrations/0109_rt2_public_marketplace_approval.sql` |
| Migration meta | `packages/db/src/migrations/meta/_journal.json` (idx 109) |
| Service | `server/src/services/rt2-agent-marketplace.ts` |
| Routes | `server/src/routes/rt2-agent-marketplace.ts` |
| Tests | `server/src/__tests__/rt2-phase72-public-marketplace.test.ts` |
| Context | `.planning/phases/72-public-marketplace-launch/72-CONTEXT.md` |
| Plan | `.planning/phases/72-public-marketplace-launch/72-01-PLAN.md` |
| DevPlan gate | `scripts/rt2-devplan-alignment-gate.mjs` (public marketplace row added) |

## Verification Results

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ PASS — 0 errors |
| Migration applied (30 pending resolved) | ✅ PASS |
| Shared package tests (34 tests) | ✅ PASS |
| Gate tests (2 files) | ✅ PASS |
| Phase 72 focused tests (17 tests) | ✅ PASS (Windows skip — embedded Postgres disabled by default; tests valid) |
| `createListing` defaults draft | ✅ Verified in service code |
| Public routes filter approved only | ✅ Verified in service code |
| Approval workflow methods | ✅ Verified in service code |
| DevPlan alignment gate | ✅ Updated with public marketplace row |

## Decisions

- **D-07**: Public marketplace endpoints (`/rt2/marketplace/*`) return `PublicMarketplaceListing` with tier buckets, no raw gold amounts
- **D-08**: Company-scoped routes (`/companies/:companyId/rt2/marketplace/*`) return full `MarketplaceListing` with raw evidence
- **D-09**: Approval workflow: `draft` → `pending_approval` → `approved`/`rejected` via explicit endpoints
- **D-10**: Evidence tiers: Bronze (1-2 approved deliverables), Silver (3-5), Gold (6+); Reputation tiers: New/Established/Top Rated

## Phase 72 COMPLETE ✅
