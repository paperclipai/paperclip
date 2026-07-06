---
title: Security, Governance & Compliance
type: concept
status: reviewed
sources: [020, 021, 022, 023, 034, 043, 050, 009, 016, 025, 024, combo-08, xcombo-04, xcombo-06, research-sources]
updated: 2026-06-24
---

# Security, Governance & Compliance

An autonomous, code-executing AI workforce spending real money is a serious security surface, and
Paperclip's controls are powerful but scattered across silos.

## Zero-trust layer (combo-08)

One policy + enforcement + tamper-proof-record stack:
- **Policy-as-code (043)** — `when <condition> then <effect>` rules at one decision seam the silos enforce.
- **Exfiltration controls** — outbound secret-leak scanning (020, content) + egress allow-listing
  (022, wire) = both channels.
- **JIT secret leasing (021)** — TTL'd leases, not standing grants.
- **Work-product security scanning (050)** — CVE/license/SAST at the review gate.
- **Tamper-evident audit log (023)** — hash-chained; every governed decision lands here.
- **Retention & PII governance (034)** — TTLs, anonymization, right-to-erasure (keep proof, drop payload).

## Trust as universal currency (xcombo-04)

One **continuous, behavior-updated trust score** per agent identity that *every* gate reads (egress 022,
secret-lease TTL 021, auto-approve 016, assignment 025, per-run caps 024), driven by the probation/ramp
(009). A drifting/compromised agent loses egress, secrets, auto-approval, and concurrency
*simultaneously*; kill-switch at trust=0. Grounded in 2026 zero-trust-for-agents (continuous
authorization; agents as first-class identities; least privilege scoped to the task).

## Provenance & Replay — auditability (xcombo-06)

Distinct from [[observability-and-health|observability]]: a **Decision Provenance Record**
(inputs+model+prompt+policy+trace+diff+cost, hash-chained into 023) reconstructs any past decision; plus
fork-restore + deterministic `planOnly` re-run to **reproduce** or **counterfactually** test it ("would
the new policy have blocked this?"). Grounded in EU AI Act Article 12 (lifetime logging; high-risk
deadline 2026-08-02) and R-LAM deterministic replay.

## Links

Trust feeds [[agent-quality-and-staffing]] and [[runtime-control-and-safety|the Autonomy Dial]]; replay
shares the simulation engine with [[pre-flight]]; audit underpins [[multi-company-and-ecosystem]].

## Provenance

- Ideas `009,016,020,021,022,023,024,025,034,043,050`; combos `combo-08`, `xcombo-04`, `xcombo-06`.
- `raw/research-sources.md` → `[zero-trust]`, `[provenance]`.

## Open questions for human review

- Roll out policy-as-code advisory-first (log would-be decisions), then enforce — acceptable parity bar?
- Egress enforcement is best-effort on bare local processes — how to surface that honestly?
- Trust-score input model & anti-oscillation before any gate enforces on it.
