# Combo 08 — Zero-Trust Security, Governance & Compliance Layer

**Combines:** 043 Policy-as-Code Governance Engine · 020 Outbound Secret-Leak Scanning ·
021 Just-in-Time Secret Leasing · 022 Per-Agent Network Egress Allow-Listing ·
023 Tamper-Evident Audit Log · 034 Data Retention & PII Governance ·
050 Code & Dependency Security Scanning of Work Products

## The unified idea

An autonomous AI workforce spending real money and executing real code is a serious security and
compliance surface, and Paperclip's controls are powerful but **scattered across silos** with no
common authoring or audit story. Seven ideas, combined, form one **zero-trust governance layer**: a
single place to *declare* rules, consistent *enforcement* at every choke point, and a *tamper-proof
record* of every decision.

- **One authoring layer (043).** A policy-as-code engine: `when <condition> then <effect>` rules
  (allow / deny / require-approval / throttle / notify / log) evaluated at a single policy-decision
  seam that the existing silos (trust presets, permissions, execution allowlists, budgets) call into
  as *enforcers*. Author in a guided builder + git-diffable DSL; dry-run a rule against last week's
  history before activating; every decision records *which rule fired and why*.
- **Stop secrets leaving in content (020).** Scan agent-produced comments/work products/docs for the
  agent's own bound secret values (exact-match, near-zero false positives) and high-confidence
  patterns before persist/surface; redact / block / flag per policy.
- **Stop secrets leaving over the wire (022).** Per-agent/per-trust-tier network egress allow-listing
  enforced at the containment/sandbox boundary; default-deny for low-trust, learning-mode to propose
  an allowlist. Together 020+022 cover both exfiltration channels.
- **Shrink the standing blast radius (021).** Just-in-time, TTL'd secret *leases* (mirroring
  `environmentLeases`) instead of permanent bindings — a credential is materialized only for the run
  that needs it, every acquisition individually audited, anomalies flagged.
- **Stop shipping insecure code (050).** At the review gate, scan code work products for CVE'd
  dependencies (OSV), disallowed licenses, and high-signal insecure patterns; severity-graded gate
  (critical blocks, medium needs override) feeding the approval risk score (combo 05); return findings
  to the agent to fix and resubmit.
- **Make the record trustworthy (023).** Hash-chain the audit log (`prevHash`/`entryHash`) so any
  retroactive edit/deletion is detectable, with a verification routine and optional external
  anchoring. This is where *every* governance decision above lands.
- **Govern the data itself (034).** Per-company retention TTLs by data class (delete/anonymize/
  archive), PII detection reusing the leak-scan machinery, and a right-to-erasure path — while
  keeping tamper-evident audit *proof* even when payloads are purged.

## Why combining wins

The policy engine (043) is the natural front-end for *all* the others — egress rules, leak-scan
responses, secret-lease limits, scan-severity gates, and retention windows are all just policies; and
*all* of them must land in the same tamper-evident log (023) to be worth anything. Secret-leak (020)
and PII detection (034) share one scanning engine; 020 (content) and 022 (wire) are two halves of one
exfiltration story; 020's "hardcoded credential" check overlaps 050's. Build one decision seam, one
scanning engine, and one trustworthy log — not seven parallel security features with seven audit gaps.

## Phasing

1. Tamper-evident audit log (023) — the substrate everything records to; build first.
2. Exact-match secret-leak scanning (020) + dependency-CVE scanning at the review gate (050).
3. JIT secret leasing (021); retention TTLs (034); egress allow-listing where the runtime supports it (022).
4. Policy-as-code engine (043) in advisory/shadow mode first, then incremental enforcement; PII +
   right-to-erasure (034).

## Ratings

- **Difficulty:** High — enforcement is runtime-dependent (egress is best-effort on bare local
  processes), canonical hashing/concurrency for the chain is fiddly, "erasure must reach every copy"
  is a completeness trap, and unifying enforcement under one seam without destabilizing working silos
  is delicate (ship advisory-first, prove parity, then take over).
- **Estimated time to complete:** ~8–12 engineer-weeks (phased; 023+020 ~3 weeks, high standalone value).
- **Importance:** 8/10 — security is close to existential for an autonomous code-executing workforce,
  and tamper-evident audit + retention/PII are exactly what unlock operating *real, regulated*
  businesses on Paperclip.
