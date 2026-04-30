# ADR 0001 — Three-repo split

**Date**: 2026-04-29
**Status**: Accepted

## Context

We need to decide how to organize code across three concerns:

1. The Koenig AI Academy product (Next.js + Convex LMS, the dashboard learners interact with).
2. The AI agent agency that runs the Academy 24/7 (and will run future products).
3. The upstream Paperclip orchestration core that the agency builds on.

A single mega-repo would be simpler ops-wise but conflates very different concerns: product code, agent configs, and an orchestration framework. Coupling them locks the framework's release cadence to the product's, and it makes spinning up the *next* product (Marketing, Sales) painful.

## Decision

Three repos:

1. **`Koenig-Solutions-Private-Limited/learnovaBeast`** — the AI-learning product. Existing repo. We work on a long-lived branch `academy/main`.
2. **`Koenig-Solutions-Private-Limited/koenig-ai-org`** — Vardaan's fork of `paperclipai/paperclip`. Houses the agency: customizations, company configs, vault, watchdog, observability.
3. **`paperclipai/paperclip`** (upstream) — tracked as a remote in koenig-ai-org. Weekly rebase script.

## Consequences

✅ Pros:
- Each repo has one job and a clean release cadence
- Adding a new product is `seed-company.sh _template <new>` inside koenig-ai-org — no LMS code touched
- Upstream Paperclip improvements flow in via rebase
- Product team and agency team can grow with separate ownership later

❌ Cons:
- Three repos to keep in sync (mitigated by upstream-rebase.sh and a small docs/upstream-merge.md)
- `learnovaBeast` retains the existing multi-portal monorepo shape (student / tc / sales / admin) — non-Academy portals stay untouched

## Alternatives considered

- **Single mega-repo**: simpler ops, but couples concerns. Rejected.
- **No fork — Paperclip as npm dep**: cleaner separation, but Paperclip's customization model uses adapter plugins via filesystem paths and skill packs — fork is more idiomatic. Reconsidered if upstream publishes a stable `@paperclipai/sdk` that supports our patterns.
- **Two repos (combine product + agency)**: rejected because the agency must be multi-product from day one.
