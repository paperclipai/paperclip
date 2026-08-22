---
type: Engineering Journal Entry
title: Phase 5 UX gate — reusable console and SDK component plan
description: Approved consumer-facing component contracts, extension points, token rules, and the mini-consumer tracer flow for the Phase 5 SDK extraction.
tags: [native-runner, phase-5, ux, browser, sdk, components, accessibility]
status: stable
generated: { by: anthropic/claude, at: 2026-08-08T07:05:00Z }
entry_kind: phase
phase: "5-ux"
---

# Context

Phase 5 generalizes the accepted Phase 4b live console into a versioned,
package-local SDK surface plus a standalone reference console, proven by a
second minimal consumer. Before implementation (PAP-16843), the UX gate
(PAP-16842) had to freeze consumer-facing contracts and re-decide the
component candidates deferred from Phase 4b.

# Decisions

1. Extraction is copy-and-freeze: the Phase 4b demo console and Phase 1–3
   surfaces stay byte-untouched as QA evidence; the SDK is a renamed copy
   under new subpath exports (`./browser`, `./react`, `./styles.css`).
2. The accepted `useLiveConsole` hook shape is frozen as the public
   `useRunnerConsole` contract, including the `announcement` accessibility
   channel. `SessionSnapshot` remains the only UI data contract.
3. Exactly five extension points: item-body renderer, request-detail
   renderer, composer action slots, `--pcr-*` token theming, and transport
   injection. Headless mode and component registries were rejected.
4. SDK classes and tokens take a `pcr-` prefix scoped to `.pcr-root`,
   preventing collisions in consumer apps; the demo keeps `ui-*`.
5. Phase 4b deferred candidates re-decided: `Response`/`CodeBlock` stay out
   of the core (served by the item-body renderer), the `Context` meter stays
   rejected (usage remains Inspector data), the command palette stays
   rejected. New rejections: headless distribution, dark theme, toast layer,
   virtualized transcript.
6. The mini consumer is deliberately not a second console: single column,
   five components, full lifecycle against fake and real drivers, with the
   extension points visibly exercised.

Full plan: [`docs/design/phase-5-component-plan.md`](../../docs/design/phase-5-component-plan.md).

# Evidence reviewed

Accepted Phase 4b console (`96092b832d`, `cda1fb03ab`) and the 23 accepted
screenshots in `knowledge/evidence/phase-04b/` (QA `09b91b63f7`) at
1440×900 and 390×844. No new pixels were judged at this gate; implementation
screenshots are a binding review requirement (plan §10).

# Gaps / next questions

- Package version number for the first frozen SDK surface is left to the
  implementer + CTO contract review (PAP-16845).
- Dark mode and virtualization are recorded non-goals; revisit only with a
  Phase 6 consuming surface or real session-size data.
