# Code Review Checklist

Lightweight reviewer checklist for merge decisions. Aligns with the engineering
operating model (PRD → Build → Review → Release).

Copy into the review comment, or keep open while reviewing. Leave unchecked
items visible — do not delete them.

**PR / change:**  
**Reviewer:**  
**Change class (risk):** Low / Medium / High  
**Date:**  

---

## Required dimensions

- [ ] **Correctness** — Change matches acceptance criteria and stated non-goals
- [ ] **Safety** — No obvious data-loss, auth-bypass, or secret-leakage path
- [ ] **Test coverage** — Tests added or updated for behavior changes
- [ ] **Backwards compatibility** — Schema / API compatibility evaluated
- [ ] **Observability** — Logs / metrics / traces are enough for diagnosis
- [ ] **Operability** — Feature flags, migrations, and rollback considered
- [ ] **Performance** — No unbounded queries / loops or major regressions
- [ ] **Documentation** — Runbook / changelog / docs updated where needed

## Gate alignment (by change class)

Use the governance gates. Risk-tier automation is tracked separately.

| Class | Minimum before approve |
|---|---|
| **Low** (docs, non-runtime tooling) | Checklist pass + CI green + 1 reviewer approval |
| **Medium** (business logic / internal API) | Checklist pass + CI + tests for changed behavior + 1 reviewer + Lead Engineer approval |
| **High** (auth, payments, data migrations, external contracts) | Checklist pass + CI + tests for changed behavior + security focus + rollback plan attached + 2 approvals (Reviewer + Lead or CTO) |

## High-risk extras (when applicable)

- [ ] Security checklist items explicitly reviewed (authz, tenant isolation, secrets)
- [ ] Rollback plan attached and plausible
- [ ] Migration / data notes call out irreversibility
- [ ] Telemetry / Observability / run-log path rules respected (`AGENTS.md` §5.7)

## Reviewer decision

- [ ] **Approve** — Ready to merge after CI / Greptile gates
- [ ] **Approve with notes** — Non-blocking follow-ups listed below
- [ ] **Request changes** — Blocking items listed below

**Blocking / follow-up notes:**  

---

## Related artefacts

| Artefact | Path |
|---|---|
| Author PR template | [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) |
| Review workflow index | [`README.md`](README.md) |
| Contributing guide | [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) |
| Release checklist (post-merge deploy) | [`../RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md) |
