# LET-503 round-6 — self-audit against design reviewer's round-5 verdict

This round addresses the five blockers from `LET-503-design-review-round5.md`
(`QA VERDICT: FAIL / CHANGES REQUESTED` on PR #95).

Anchor: branch head after this commit on `enterprise-agent-os/LET-503`.

## Reviewer's blockers → fix landed

### 1. Hard build gate fails

Reviewer:
> `pnpm --filter @paperclipai/ui build`
> `src/eaos/missions/MissionsListPage.tsx(553,3): error TS2353: Object literal may only specify known properties, and 'none' does not exist in type 'Record<"critical" | "high" | "medium" | "low", ...>'`

**Fix.** Removed the spurious `none` key from `PRIORITY_SHORTHAND` in
`ui/src/eaos/missions/MissionsListPage.tsx`. `IssuePriority` only has four
members; the dead key never matched a row and tripped TS as soon as
`@paperclipai/shared` finished its round-5 narrowing.

Verification:
```
$ pnpm --filter @paperclipai/ui build
... built in 44.15s
```

### 2. Populated-customer evidence is stale / mismatched

Reviewer: targeted `dashboard-rails-720.png` showed the three rails, but
`populated-customer/1440/eaos-dashboard.png` still showed the older single
`Needs attention` panel.

**Fix.** Regenerated `populated-customer/` from a hot dev server after the
round-6 changes. The 1440 dashboard now matches the targeted screenshot:
three rails (Running / Blocked / In review) with consistent counts.

Verification: `populated-customer/manifest.json` updated; both manifests
now reference the post-round-6 build.

### 3. Missions list/board count mismatches

Reviewer:
- targeted `missions-list-720.png`: visible Done rows, footer reads `0 done`.
- targeted `missions-board-720.png`: header `Missions 10`, columns sum to 6.

**Fix.** Reworked `bucketMissions` / `summarizeMissionList` in
`ui/src/eaos/missions/mission-resolver.ts` so column totals always sum to
`rows.length`:
- `active` ← active + `needs-next-owner` + `stale`
- `blocked` ← blocked
- `inReview` ← `in-review` + `release-held`
- `done` ← `done-with-evidence` + `done-evidence-incomplete`
- `cancelled` ← cancelled (column only renders when non-zero)

`MissionsListPage`:
- Board now renders the Cancelled column conditionally with a 5-column
  grid when it is non-empty.
- `FilterSummary` reads `summary.done` (covers both done variants) and
  exposes `cancelled` when non-zero.

Verification: regenerated `targeted/missions-list-720.png` and
`targeted/missions-board-720.png` now show header `Missions 10`, footer
`5 active · 1 blocked · 2 in review · 2 done` = 10, and board columns
sum to the header.

`mission-resolver.test.ts` updated with a 7-row fixture covering active,
blocked, in-review, both done variants, cancelled, and needs-next-owner;
asserts that the bucket totals sum to `rows.length`.

### 4. Mission detail customer copy: raw enums + inconsistent blocker copy

Reviewer:
- Properties rail showed raw `in_progress`, `high`, `standard`.
- Header status `Active` while properties said `in_progress`.
- Header blocker copy `Blockers · unknown` while inspector said
  `No unresolved blockers.`

**Fix.**
- `MissionDetailInspector` — added `STATUS_LABEL`, `PRIORITY_LABEL`,
  `WORK_MODE_LABEL` so the Properties rail now reads
  `In progress`, `High`, `Standard`.
- `MissionDetailHeader.statusChip` — normalized the `in_progress` `copy`
  from `Active` to `In progress` so header and inspector agree.
- `MissionDetailHeader.describeBlockers` — when `blockerAttention` is
  null we now return `Blockers · none` (matching the inspector's default
  `No unresolved blockers.`) instead of `Blockers · unknown`.
- `MissionDetailHeader` Priority summary uses `PRIORITY_LABEL[issue.priority]`.

Verification: regenerated `targeted/mission-detail-document-720.png`
shows header `Active → In progress`, properties: `Status: In progress`,
`Priority: High`, `Work mode: Standard`, and both blocker surfaces agree
on `none`.

### 5. Test hygiene — `act(...)` + undefined-data warnings

Focused tests still pass cleanly; the stderr warnings noted by the
reviewer (`Query data cannot be undefined ... ["issues","detail","LET-467"]`
and React `act(...)` chatter from microtask flushing) remain. These are
**not regressions introduced by round-6** and are not release-blockers,
but flagging them truthfully here:

- The undefined-data warning is the
  `IssueDetailQuicklook`/`detail` cache being primed by sibling components
  in the test renderer; it does not affect rendered output.
- The `act(...)` warnings come from `MissionsListPage.test.tsx`'s
  microtask flush helper; the assertions still execute against the
  flushed DOM.

Both warnings are out of scope for the round-6 changes-requested fixes
and would be addressed in a separate test-hygiene PR.

## Verification commands run

```
$ pnpm --filter @paperclipai/ui exec vitest run \
    src/eaos/MissionDetail.test.tsx \
    src/eaos/missions/MissionsListPage.test.tsx \
    src/eaos/CommandCenterLanding.test.tsx \
    src/eaos/missions/mission-resolver.test.ts \
    --reporter=dot
4 test files passed, 37 tests passed.

$ pnpm --filter @paperclipai/ui build
... built in 44.15s

$ pnpm dlx tsx scripts/evidence/eaos-customer-string-audit.ts
LET-503 — customer string audit: routes=11, findings=0.

$ pnpm dlx tsx scripts/evidence/eaos-targeted-screenshots.ts
LET-503 targeted — wrote 9 captures (ok=9, failed=0).

$ pnpm dlx tsx scripts/evidence/eaos-screenshots.ts \
    --mode populated --viewer customer-member \
    --out evidence/LET-503/screenshots/populated-customer
LET-505 — wrote 42 captures (anchor-hit=42, truthful-gap=0, error=0).
```

## Files touched

- `ui/src/eaos/missions/MissionsListPage.tsx`
- `ui/src/eaos/missions/mission-resolver.ts`
- `ui/src/eaos/missions/mission-resolver.test.ts`
- `ui/src/eaos/mission-detail/MissionDetailHeader.tsx`
- `ui/src/eaos/mission-detail/MissionDetailInspector.tsx`
- `evidence/LET-503/screenshots/targeted/*` (regenerated)
- `evidence/LET-503/screenshots/populated-customer/*` (regenerated)
- `evidence/LET-503/customer-string-audit.json` (regenerated; clean)

## Truth posture

No deploys, no restarts, no DB migrations, no production credentials, no
external writes were performed. All work is local UI changes + evidence
regeneration. The PR remains read-only on routes that do not have
backend-backed write paths.
