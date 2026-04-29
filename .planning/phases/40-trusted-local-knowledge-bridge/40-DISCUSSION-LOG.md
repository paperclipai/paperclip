# Phase 40: Trusted Local Knowledge Bridge - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** 40-trusted-local-knowledge-bridge
**Mode:** auto
**Areas discussed:** Trust Boundary And Pairing, Sync Queue And Health Evidence, Knowledge Contract Preservation, Operator Surface, Verification

---

## Trust Boundary And Pairing

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing Knowledge Bridge | Add pairing identity, token/handshake evidence, heartbeat, and company boundary checks on top of current vault writer/import routes. | yes |
| Create separate local bridge subsystem | Build a separate daemon domain disconnected from Knowledge Bridge routes. | |
| Direct server local-path writes | Let the web server write directly to arbitrary desktop vault paths. | |

**Auto choice:** Extend existing Knowledge Bridge.
**Notes:** Phase 21 explicitly deferred physical local daemon work but established the safe dry-run/import contract. Phase 40 should keep the daemon as a trusted external worker and avoid unsafe arbitrary server filesystem writes.

---

## Sync Queue And Health Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence-backed queue and health model | Persist queue items, last applied, conflict count, blocked reason, bridge status, and last seen with reason codes and timestamps. | yes |
| Boolean connected/disconnected only | Show only whether a bridge appears connected. | |
| Re-run import/export synchronously only | Keep bridge operations as transient request responses without queue evidence. | |

**Auto choice:** Evidence-backed queue and health model.
**Notes:** Phase 40 success criteria require queue, last applied, conflict count, blocked reason, unavailable, stale, and conflict scenarios to be API/UI visible and testable.

---

## Knowledge Contract Preservation

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve RT2 canonical storage and approved apply | Local markdown remains inspection/edit surface; write-back enters RT2 through approved import candidates/conflict decisions. | yes |
| Treat vault files as canonical | Let the local vault override RT2 wiki/graph state by default. | |
| Trust Obsidian wikilinks as extracted facts | Promote vault-originated graph relationships to EXTRACTED confidence. | |

**Auto choice:** Preserve RT2 canonical storage and approved apply.
**Notes:** Prior phases locked RT2 DB/projectors/audit rows as canonical. Vault-originated wikilinks remain AMBIGUOUS until reviewed.

---

## Operator Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Extend KnowledgePage Bridge tab | Add pairing status, bridge identity, queue counts, last applied, conflicts, blocked reason, and audit evidence beside existing vault controls. | yes |
| Add a new top-level dashboard | Create a separate local bridge dashboard. | |
| CLI-only daemon status | Keep local bridge health outside the product UI. | |

**Auto choice:** Extend KnowledgePage Bridge tab.
**Notes:** Existing `KnowledgePage` already concentrates Bridge, vault writer, import, graph report, and contradiction workflows. Phase 40 should keep the operator loop in that surface.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Embedded persistence tests plus fallback contracts | Cover DB-backed behavior where possible and deterministic route contracts where embedded Postgres skips. | yes |
| Live daemon required for tests | Require a real local daemon/process for default verification. | |
| Typecheck only | Rely on compile checks without behavioral scenarios. | |

**Auto choice:** Embedded persistence tests plus fallback contracts.
**Notes:** Project constraints require deterministic local dev and CI. Tests should cover pairing, company boundary, unavailable/stale/blocked/conflict states, queue updates, and provenance preservation.

---

## the agent's Discretion

- Exact DB table names and route path naming.
- Exact daemon protocol payload shape.
- Exact stale threshold and Bridge tab layout.
- Exact reason-code vocabulary, as long as blocked/unavailable/stale/conflict remain typed and visible.

## Deferred Ideas

- Slack/Teams/native/mobile capture source installation and mobile review queue — Phase 41.
- Jarvis rewrite proposal/eval guardrails — Phase 42.
- App-store style native distribution and push notifications — future native distribution scope.
- Cross-company knowledge federation — future trusted ecosystem scope.
