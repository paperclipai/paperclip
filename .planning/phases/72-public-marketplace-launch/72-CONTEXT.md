# Phase 72: Public Marketplace Launch - Context

**Gathered:** 2026-05-01T18:50:00+09:00
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 72 transforms the existing company-scoped/trusted-ecosystem marketplace (from Phase 70) into a public/open marketplace launch. Public listings must be discoverable outside the company evidence ecosystem, go through an approval workflow, and preserve quality/price/reputation evidence integrity even when viewed outside the trusted company boundary.

This phase must build on the shipped Phase 70 economy/marketplace baseline, Phase 66 daily cockpit, Phase 69 corpus graph, and current rt2AgentMarketplace service/routes. It must not create real payment settlement (BILL-01 deferred), billing export, or cross-company federation evidence (FED-01 deferred). The goal is to make listings publicly discoverable with an approval gate and evidence contract that survives outside the trusted ecosystem.

Key distinction from Phase 70:
- Phase 70 D-11: "Marketplace listings stay company-scoped/trusted-company ecosystem evidence for this phase. Public/open marketplace launch and real payment settlement are out of scope."
- Phase 72: Overturns that boundary — public/open marketplace is now in scope.

</domain>

<decisions>
## Implementation Decisions

### Public Listing Discovery and Visibility
- **D-01:** Public marketplace endpoints (`/rt2/marketplace/*`) remain accessible without company authentication. Listing metadata, quality evidence, and reputation signals are visible publicly. Private settlement/ledger/CareerMate evidence (actual gold amounts, internal P&L data) stay behind company-scoped routes.
- **D-02:** A new `listingApprovalStatus` field (`draft` | `pending_approval` | `approved` | `rejected`) on `rt2AgentMarketplace` controls whether a listing appears in public search/list results. Only `approved` listings are publicly discoverable.
- **D-03:** Settlement/ledger-derived evidence shown on public listing pages uses derived/approximated values, not raw internal gold amounts. Example: "estimated value" ranges or tier badges instead of precise ledger balances.
- **D-04:** Public search results show evidence status (`ready` | `partial` | `missing`) so visitors know whether a listing has proven deliverables/quality or is speculative.

### Approval Workflow for Public Listings
- **D-05:** Company operators create listings as `draft` by default. A new `/companies/:companyId/rt2/marketplace/listings/:listingId/submit-for-approval` endpoint transitions `draft` → `pending_approval`.
- **D-06:** An approval review surface (company-admin route) lists pending submissions. Admins can `approve` → `approved` or `reject` → `rejected` with a reason. Rejected listings return to `draft` state for revision.
- **D-07:** Only `approved` listings appear in public `/rt2/marketplace/agents` list and search results. Draft/pending/rejected listings are visible only to the creating company.
- **D-08:** Listing evidence enrichment (deliverable count, quality average, reputation index) must be complete enough for approval — minimum evidence status must be `partial` before submission. Listings with `missing` evidence status are warned but not blocked.

### Public Metadata vs Private Evidence Contract
- **D-09:** Public listing response contains: listing core fields + evidence summary (deliverable count, quality tier, reputation tier, subscription count) + evidence status. It does NOT contain: raw gold amounts, internal P&L data, per-settlement details, internal CareerMate stats.
- **D-10:** Company-scoped listing response (for the listing owner) additionally includes: raw approvedBasePriceGold, earnedGoldEstimate, latestApprovedDeliverables detail, settlement outcome summary, and CareerMate progression basis. This stays behind `/companies/:companyId/rt2/marketplace/agents` routes.
- **D-11:** Evidence tier classification: use buckets (e.g., "Bronze" 1-2 approved deliverables, "Silver" 3-5, "Gold" 6+) instead of raw counts on public surfaces. Raw counts appear only on company-scoped routes.
- **D-12:** Reputation tier on public listings uses collaboration multiplier and subscription count, not raw reputationIndex values. Buckets (e.g., "New", "Established", "Top Rated") replace precise numbers.

### Marketplace Search and Discovery
- **D-13:** Public search (`/rt2/marketplace/search`) filters to `approved` listings only. Company-scoped search (`/companies/:companyId/rt2/marketplace/search`) includes draft/pending/own-company approved listings.
- **D-14:** Public listing detail (`/rt2/marketplace/agents/:listingId`) returns the public evidence contract (D-09). Add a `?includePrivate=true` query param for company-scoped requests to augment with private evidence.
- **D-15:** Search ranking uses: approval status, evidence status, rating average, subscription count — not raw gold/earnings.

### Governance and Verification
- **D-16:** Update `scripts/rt2-devplan-alignment-gate.mjs` so `Public/open marketplace launch` becomes `complete` only after: approval workflow fields/routes, public vs private evidence contract, evidence tier buckets, and focused tests are all anchored.
- **D-17:** Verification includes focused service/route tests for: approval state transitions, public listing visibility filtering, evidence tier bucketing, and public/private response contract separation.
- **D-18:** Default verification remains `pnpm typecheck && pnpm test`. Do not run `pnpm test:e2e` as the default Phase 72 gate.

### Agent's Discretion
- Exact field names for approval status enum values, provided they map cleanly to `draft` | `pending_approval` | `approved` | `rejected`.
- Exact tier bucket thresholds, provided they are documented in tests and UI copy is Korean-first.
- Whether approval review surface is a new route group or additions to existing marketplace routes.
- Exact visual layout for evidence tier badges on public listing cards, provided it uses the bucket model.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, lockfile policy.
- `.planning/PROJECT.md` - v3.2 Future Scope goal and public marketplace scope.
- `.planning/REQUIREMENTS.md` - `MKT-01`, `MKT-02`, and `MKT-03`.
- `.planning/ROADMAP.md` - Phase 72 goal, success criteria.
- `.planning/STATE.md` - v3.2 milestone state.

### Prior Phase Decisions
- `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-CONTEXT.md` - Company-scoped marketplace evidence baseline, D-11 public/open marketplace deferred.
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Evidence-backed completion and product identity rules.
- `.planning/phases/66-daily-work-and-okr-cockpit-convergence/66-CONTEXT.md` - Daily cockpit placement and evidence surface decisions.

### Existing Marketplace Code
- `packages/db/src/schema/rt2_agent_marketplace.ts` - rt2AgentMarketplace, rt2ByoaAgents, rt2AgentSubscriptions schema.
- `server/src/services/rt2-agent-marketplace.ts` - Marketplace listing, evidence enrichment, BYOA, subscription service.
- `server/src/routes/rt2-agent-marketplace.ts` - Public and company-scoped marketplace routes.
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` - Existing marketplace tests.
- `scripts/rt2-devplan-alignment-gate.mjs` - v3.1 completion truth gate to update after implementation.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2AgentMarketplaceService.listMarketplaceAgents` already returns `MarketplaceListing[]` with `evidence` field enriched from deliverables, quality rows, and subscriptions.
- `rt2AgentMarketplaceService.getMarketplaceListing` already enriches a single listing with evidence.
- `rt2AgentMarketplaceService.searchMarketplaceAgents` already filters by name/description/tags.
- Public routes (`/rt2/marketplace/*`) already exist without `assertCompanyAccess`.
- Evidence status classification (`ready` | `partial` | `missing`) already exists in `MarketplaceListingEvidence`.

### Established Patterns
- Company-scoped routes use `assertCompanyAccess` and return enriched/private data.
- Public routes omit auth and return limited/derived data.
- Approval state transitions use explicit endpoint actions (not bare status updates).
- Tier/bucket models used elsewhere in RT2 (e.g., reputation bands in CareerMate).
- Focused Vitest route/service tests are accepted evidence on this Windows host.

### Integration Points
- Add `listingApprovalStatus` column to `rt2AgentMarketplace` schema.
- Update `listMarketplaceAgents` to filter to `approved` status for public routes.
- Update `createListing` to default to `draft` approval status.
- Add submit-for-approval, approve, reject endpoints.
- Add evidence tier bucketing on public listing responses.
- Update DevPlan alignment gate to reflect public marketplace scope.

</code_context>

<specifics>
## Specific Ideas

- Recommended approval status values: `draft` (not visible publicly), `pending_approval` (awaiting review), `approved` (visible publicly), `rejected` (rejected with reason, not visible).
- Recommended public evidence contract fields: `{ listingId, name, category, tags, pricingSummary, evidenceTier, reputationTier, deliverableTier, subscriptionCount, evidenceStatus, approvalStatus }`.
- Recommended tier buckets:
  - Evidence tier: Bronze (1-2 approved deliverables), Silver (3-5), Gold (6+)
  - Reputation tier: New (no subscriptions), Established (1-10), Top Rated (11+)
  - Quality tier: Bronze (<50 avg), Silver (50-74), Gold (75+)
- Recommended public listing detail response shape: public contract + `{ evidenceTier, reputationTier, qualityTier, pricingSummary, approvalStatus }` with no raw gold amounts.

</specifics>

<deferred>
## Deferred Ideas

- Real payment settlement and ledger integration (BILL-01) remains Phase 73 scope.
- Cross-company federation marketplace behavior (FED-01) remains Phase 74 scope.
- BYOA agent public discovery remains out of scope — only agent marketplace listings go public in Phase 72.
- Subscription cancellation and billing export remain Phase 73 scope.

</deferred>
