---
title: Multi-Company, Cross-Company & Ecosystem
type: concept
status: reviewed
sources: [007, 018, 033, 039, 053, 054, 064, combo-10, combo-13, xcombo-14, research-sources]
updated: 2026-06-24
---

# Multi-Company, Cross-Company & Ecosystem

Companies in one instance are hard-isolated by design. Three things operators want require *deliberately*
piercing that boundary through one governed seam — plus the adoption/ecosystem layer around it.

## Governed cross-company fabric (combo-13)

The key insight: holding directives, shared services, and inter-company messages are **three message
types on one governed channel**, not three bridges.
- **Company Mailbox (054)** — typed message envelopes; the single audited cross-company door (leak-scanned,
  see [[security-governance]]).
- **Holding company (007)** — `directive` messages: a meta-company with a narrow `portfolio_oversight`
  read + governed-write capability; capital allocation is the killer action (see
  [[economics-and-finance|Capital Allocator]]).
- **Shared services (053)** — `service_request` tickets with chargeback so shared work is economically honest.

## Adoption kit (combo-10)

Get a new operator from cold install to value fast: blueprint library (018), guided onboarding + runnable
demo (039), dry-run estimator (004, see [[pre-flight]]), data import from Jira/Linear/etc. (064), work
templates & DoD (058). All ride the company-portability serializer + the dry-run preview.

## Ecosystem / marketplace (xcombo-14, queued)

Blueprints (018) + signed community sharing + shared services (053) + skills/teams catalogs + skill-
effectiveness (046) → a trust-gated exchange of orgs, agents, skills, and services.

## Provenance

- Ideas `007,018,033,039,053,054,064`; combos `combo-10`, `combo-13`, queued `xcombo-14`.

## Open questions for human review

- The cross-company seam is a reviewed *security surface* — build read-only first, then governed writes, then capital?
- Community blueprint/skill sharing introduces a trust/supply-chain surface — gating model?
