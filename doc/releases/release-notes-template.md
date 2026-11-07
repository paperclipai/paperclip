# Release Notes Template

Use this structure for stable notes (`releases/vYYYY.MDD.P.md`), beta soak
drafts (`releases/beta/v<beta-version>.md`), and issue-document `release-notes`
entries. Keep user-facing voice in the Summary / Changes sections; keep
operational fields (rollback, monitoring) filled for auditability even when
the public GitHub Release trims them.

Copy and fill. Delete unused optional sections only when they truly do not
apply — prefer writing `None` over deleting rollback or verification.

---

```md
# Paperclip vYYYY.MDD.P

> Released: YYYY-MM-DD
> Release issue: PSVA-XXXX
> Release type: Standard / Coordinated / High-Risk / Hotfix / Rollback
> Owner-on-point: Release Engineer <name>

## Summary

[1–3 sentences: what changed and why it matters.]

## User Impact

[What operators/users will notice. Write "None — internal only" if applicable.]

## Changes

### Features

- **[Title].** [Description.] ([#PR](url) / [PSVA-XX](/PSVA/issues/PSVA-XX))

### Fixes

- **[Title].** [Description.] ([#PR](url))

### Improvements / Chores

- **[Title].** [Description.] ([#PR](url))

## Product Scope

- Included:
- Explicitly not included:

## Technical Scope

- Systems / packages touched:
- API / contract changes:
- UI surfaces:

## Upgrade Guide

- Migrations:
- Config / env changes:
- Feature flags (name, default, rollout rule, cleanup issue):
- Breaking changes:

## Known Limitations

- [Limitation or "None"]

## Rollback

- **Rollback decision owner:**
- **Rollback execution owner:**
- **Trigger:**
- **Steps:**
  1.
  2.
- **Data / migration constraints:**
- **Expected user impact during rollback:**
- **Post-rollback verification:**

## Monitoring Verification

- **Verification owner:**
- **Verification window (UTC):**
- **Signals checked:**
  - [ ] Error rate / alerts
  - [ ] Latency / key API health
  - [ ] Critical user / operator flow
  - [ ] Jobs / queues (if applicable)
  - [ ] Frontend / client health (if applicable)
  - [ ] Feature flag / config state
- **Result:** PASS / FAIL / PARTIAL
- **Evidence (links, no secrets):**
- **Issues found / follow-ups:**

## Communication

- Internal:
- External / changelog:
- Marketing / launch (if any):

## Follow-Up

| Item | Owner | Issue |
|---|---|---|
|  |  |  |
```

---

## Field requirements (do not ship notes without these)

For any coordinated, high-risk, hotfix, or rollback release, the published or
issue-attached notes **must** include:

1. **Rollback decision owner** and **rollback execution owner**
2. **Monitoring verification** with named verification owner and PASS/FAIL/PARTIAL
3. Link back to the readiness checklist / go-no-go evidence on the release issue

Standard low-risk releases may mark rollback as "revert commit / previous
dist-tag via `scripts/rollback-latest.sh`" and still must name who decides and
who verifies.

## Mapping to lane publish notes

When drafting beta/stable notes under `releases/`, keep the public changelog
sections (Summary, Changes, Upgrade Guide) in the existing voice used by prior
`releases/v*.md` files. Carry Rollback and Monitoring Verification either:

- inline in the same file (preferred for high-risk), or
- as a short "Operations" section that links to the filled checklist on the
  release issue when the public note must stay user-facing-only.
