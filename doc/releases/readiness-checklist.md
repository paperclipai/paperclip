# Release Readiness Checklist

Copy this checklist into the release issue (or attach as the `release-checklist`
document) before go/no-go. Leave unchecked items visible — do not delete them.

**Release name / issue:**  
**Release type:** Standard / Coordinated / High-Risk / Hotfix / Rollback  
**Target environment / lane:** canary / nightly / beta / stable / other  
**Owner-on-point (Release Engineer):**  
**Date / revision:**  

---

## 1. Scope

- [ ] Scope is clear (what ships / what does not)
- [ ] Acceptance criteria satisfied or consciously waived (waiver noted below)
- [ ] Non-goals recorded
- [ ] Linked implementation issues identified

**Waiver / exception notes:**  

## 2. Owners and handoffs

- [ ] Product scope owner confirmed (if product-facing)
- [ ] Backend readiness owner confirmed (if backend/API/jobs/migrations)
- [ ] Frontend readiness owner confirmed (if UI/flags/client contract)
- [ ] Code Reviewer approval complete or exception approved
- [ ] Release Engineer owner-on-point named
- [ ] Verification owner named
- [ ] Rollback decision owner named
- [ ] Rollback execution owner named

## 3. Quality gates

- [ ] Required CI/checks passed or exception approved
- [ ] Failed checks (if any) diagnosed — not ignored
- [ ] Security / auth / data risks reviewed when applicable
- [ ] Unresolved review risks named with owner

**Check evidence (links):**  

## 4. Deploy path

- [ ] Deploy / promotion order is known
- [ ] Environment dependencies ready (config present; secrets referenced, not pasted)
- [ ] Feature flags / config documented (name, default, rollout, owner)
- [ ] Migrations / backfills sequenced and backward-compat understood
- [ ] Irreversible steps called out explicitly
- [ ] Third-party / integration dependencies ready if applicable

## 5. Observability

- [ ] Dashboards / logs / alerts identified for key paths
- [ ] Error-rate / latency / critical-flow signals known
- [ ] Stop conditions defined (when to hold or roll back)
- [ ] Who watches during rollout is named

## 6. Rollback

- [ ] Rollback trigger defined
- [ ] Rollback steps documented
- [ ] Data / migration rollback constraints documented
- [ ] Feature-flag disable path understood (if applicable)
- [ ] Expected time-to-rollback estimated
- [ ] Post-rollback verification steps defined

## 7. Verification

- [ ] Pre-release verification steps defined
- [ ] During-rollout checks defined
- [ ] Post-release verification steps defined
- [ ] Monitoring verification owner named (who confirms signals after ship)

## 8. Approvals (by release type)

### Standard

- [ ] Readiness checklist complete
- [ ] Review + checks evidence attached

### Coordinated

- [ ] Release plan / owner map attached
- [ ] Deploy order agreed by involved leads

### High-Risk

- [ ] CTO review recorded
- [ ] Product scope confirmation recorded
- [ ] Code Reviewer approval recorded
- [ ] Staged rollout preferred (or waiver)
- [ ] CEO / board confirmation if business or reputation risk is material

### Hotfix

- [ ] Production impact confirmed
- [ ] Scope is narrow
- [ ] Minimum safe review/checks confirmed
- [ ] Heightened monitoring plan confirmed
- [ ] Follow-up / retrospective planned if impact was material

### Rollback

- [ ] Rollback decision owner confirmed
- [ ] Immediate user-impact assessment recorded
- [ ] Follow-up root-cause issue filed or linked

## 9. Go / No-Go

**Decision:** GO / HOLD / NO-GO  

**Rationale:**  

**Blockers (if HOLD / NO-GO):**  

| Blocker | Owner | Exact ask |
|---|---|---|
|  |  |  |

**Next action:**  

---

## Sign-offs

| Role | Name / agent | Decision | Timestamp (UTC) |
|---|---|---|---|
| Product Manager |  |  |  |
| Lead Backend Developer |  |  |  |
| Lead Frontend Developer |  |  |  |
| Code Reviewer |  |  |  |
| Release Engineer |  |  |  |
| CTO (if required) |  |  |  |
| CEO (if required) |  |  |  |

N/A cells are fine when that role is not in scope for this release type.
