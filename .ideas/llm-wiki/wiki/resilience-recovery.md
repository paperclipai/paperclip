---
title: Resilience, Disaster Recovery & Incidents
type: concept
status: reviewed
sources: [015, 045, 051, 057, 014, combo-09, xcombo-07, research-sources]
updated: 2026-06-24
---

# Resilience, Disaster Recovery & Incidents

When something breaks in a 24/7 autonomous system, how do we recover safely? One resilience stack across
three blast radii — one company, the whole instance, and the live operation.

## The resilience stack (combo-09)

- **Company point-in-time rewind (015)** — lightweight snapshots + checkpoints before high-risk events;
  fork-restore (safe) before in-place rewind (destructive). Honestly scoped: restores control-plane
  state, not the outside world. (Shares the simulation/restore engine with [[pre-flight]] and
  [[security-governance|Provenance & Replay]].)
- **DR backup verification (051)** — integrity manifests + **automated restore drills** into a throwaway
  DB (an untested backup is a hope) + a recovery-posture surface (RPO/RTO).
- **Incident management & on-call (057)** — generalize budget incidents into a real incident object with
  severity + on-call routing; auto-raisable from existing signals (budget, reliability, security,
  deadlock); SEV1 can auto-Drain ([[runtime-control-and-safety]]).
- **Plugin versioning/rollback/health (045)** — pin, staged upgrade with auto-rollback, health monitoring.

## Relationship to the Self-Healing Org

This combo heals *data/infra/runtime*; the [[agent-quality-and-staffing|Self-Healing Org]] (xcombo-07)
applies the same detect→diagnose→remediate→verify loop to *staffing & structure*. Together: a company that
repairs both its infrastructure and its workforce.

## Provenance

- Ideas `014,015,045,051,057`; combos `combo-09`, `xcombo-07`.
- `raw/research-sources.md` → `[self-healing]`.

## Open questions for human review

- Restore is the hard part everywhere (transactional integrity, in-flight runs, un-undoable external side effects) — framing?
- Incident fast-path that genuinely bypasses normal scheduling for mixed agent+human responders.
