# Release Governance Templates

Reusable release-process artefacts for Paperclip governance (PSVA-36 / PSVA-42).

These templates sit **above** the lane mechanics in [`../RELEASING.md`](../RELEASING.md)
and the per-lane captain checklist in [`../RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md).
Use them whenever a change needs an explicit go/no-go, owner map, or auditable
release note — especially coordinated, high-risk, hotfix, and rollback releases.

## Templates

| Artefact | Path | When to use |
|---|---|---|
| Release readiness checklist | [`readiness-checklist.md`](readiness-checklist.md) | Before promoting to beta/stable, before a coordinated/high-risk deploy, or before a hotfix |
| Release notes template | [`release-notes-template.md`](release-notes-template.md) | Drafting `releases/beta/v*.md` or `releases/vYYYY.MDD.P.md`; also for issue-thread release-notes documents |

## Mandatory sign-off and handoff sequence

Do not skip steps. A later lane does not substitute for an earlier gate.

```text
1. Scope lock (Product Manager)
   → What ships / what does not / acceptance criteria confirmed

2. Implementation ready (Lead Backend / Lead Frontend as applicable)
   → Deploy order, migrations/flags, env readiness named

3. Code review complete (Code Reviewer)
   → Required checks green or documented exception approved

4. Release readiness (Release Engineer)
   → Fill readiness-checklist.md; classify release type
   → Confirm rollback owner, verification owner, observability

5. Go / No-Go (Release Engineer + required approvers)
   → Standard: RE + reviewer evidence
   → Coordinated: owners named on checklist
   → High-risk: CTO (+ CEO if business/reputation risk)
   → Hotfix: narrow scope + rollback + verification explicit

6. Deploy / promote (Release Engineer coordinates; lane owner executes)
   → Follow RELEASING.md + RELEASE-CHECKLIST.md for the target lane

7. Post-release verification (named verification owner)
   → Complete monitoring/verification section; record PASS/FAIL/PARTIAL

8. Release notes (Release Engineer or release captain)
   → Draft notes during soak / pre-ship using release-notes-template.md
     (narrative + known owners may start as early as step 4–6)
   → Complete monitoring verification fields only after step 7 evidence exists
   → Land notes per RELEASING.md with rollback owner + verification evidence

9. Handoff / close
   → Status: shipped (or rolled back)
   → Follow-up issues filed; retrospective if material impact
```

### Gate rule

If any material checklist item is unchecked and has no approved exception, the
release is **HOLD**. Do not promote or expand rollout.

### Role map (quick)

| Gate | Primary owner | Escalate to |
|---|---|---|
| Product scope | Product Manager | CEO (strategic risk) |
| Backend/API/migration readiness | Lead Backend Developer | CTO |
| Frontend/flag/UI readiness | Lead Frontend Developer | CTO |
| Review quality | Code Reviewer | CTO |
| Readiness / go-no-go / rollback / verification | Release Engineer | CTO |
| High-risk technical policy | CTO | CEO |
| Public launch timing | CMO | CEO |

## Relationship to existing docs

- **Lane mechanics** (canary → nightly → beta → stable): [`../RELEASING.md`](../RELEASING.md)
- **Lane captain checklist**: [`../RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md)
- **Published notes location**: `releases/vYYYY.MDD.P.md` (stable) and
  `releases/beta/v<beta-version>.md` (soak draft)
- **Governance templates** (this directory): readiness + notes structure for
  owners, rollback, and monitoring verification
