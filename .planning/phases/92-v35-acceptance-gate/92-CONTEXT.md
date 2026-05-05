# Phase 92: v3.5 Acceptance Gate — Context

**Gathered:** 2026-05-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 92 is the v3.5 milestone closure gate. It verifies that all POWER requirements (POWER-01 through POWER-06) are implemented and functional, then closes the milestone.

</domain>

<decisions>
## What's Needed

- Verify POWER-01~03 (Phase 88-89) — checklist, labels, due dates ✓
- Verify POWER-04~06 (Phase 91) — formula fields, WIP limits, card templates ✓
- Milestone archive and ROADMAP update

</decisions>

<canonical_refs>
## Verification Checklist

### POWER-01: Checklist (Phase 88)
- [ ] Checklist items stored in `rt2WorkBoardChecklistItems`
- [ ] UI shows checklist on card face
- [ ] Can add/check/uncheck/reorder items

### POWER-02: Labels/Members (Phase 89)
- [ ] Labels shown on card face
- [ ] Members shown on card face

### POWER-03: Due Dates (Phase 89)
- [ ] Calendar view exists
- [ ] Cards show due date

### POWER-04: Formula Fields (Phase 91)
- [ ] `formulaExpression` column on custom field
- [ ] Formula computed at read time
- [ ] "fx" badge on formula field chips

### POWER-05: WIP Limits (Phase 91)
- [ ] Lane settings API routes working
- [ ] Lane header shows count/limit
- [ ] Warning when at limit

### POWER-06: Card Templates (Phase 91)
- [ ] Template CRUD API routes
- [ ] Template selector in UI

</canonical_refs>

<deferred>
## Deferred

- Full E2E testing (not in scope for this gate)
- UI template management page (can be added later)

</deferred>
---
*Phase: 92-v35-acceptance-gate*
*Context gathered: 2026-05-05*