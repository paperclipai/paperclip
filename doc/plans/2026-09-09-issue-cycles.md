# Issue Cycles Proposal

Status: proposal. No code changes. Seeks maintainer direction before any
Path-2 implementation work.

## Context

Teams work in time-boxes: two-week sprints, monthly milestones, release
trains. A time-box turns an open backlog into a commitment with a start, an
end, and a visible burn-down. Plane models this with per-project Cycles:
named date ranges owning issues, with cached progress snapshots. Paperclip
has recurring routines and single project deadlines, but no container for
"this set of issues, done by this date, tracking this burn-down." This
proposal ports time-boxed cycles to Paperclip's issue model.

## What We Know Today

- Issues carry lifecycle timestamps (`startedAt`, `completedAt`,
  `cancelledAt` on `issues` in `packages/db/src/schema/issues.ts`) — the
  raw material for progress computation already exists on every row.
- Projects carry a single `targetDate`. Routines cover recurrence
  (cron-like schedules in the routines domain), not bounded iterations.
  No sprints, milestones, or cycles exist as product concepts; the words
  appear in the codebase only incidentally.
- Activity history with action attribution exists (the shipped Activity log
  surface), so burn-down can read durable events rather than recomputing
  from live rows.
- The audit area already renders run history and progress summaries,
  establishing UI idioms a cycle progress view can reuse.
- Prior art studied in Plane (`apps/api/plane/db/models/cycle.py`):
  - `Cycle`: name, description, start/end datetimes, timezone, owner,
    view props, `progress_snapshot` (cached rollup JSON), archived flag,
    version.
  - `CycleIssue`: link table binding issues to cycles with uniqueness
    guards.
  - Progress snapshots cache the rollup so burn-down reads stay cheap.

## The Gap

Without time-boxes, operators cannot express "sprint 12" or "September
milestone" anywhere in the product. Routines answer "every Monday", and
`targetDate` answers one project deadline, but neither scopes a set of
issues to a shared window with progress tracking. The roadmap asks for
exactly this capability under Work Queues (queue-style streams are the
continuous counterpart; cycles are the time-boxed counterpart) and it
feeds Self-Organization (agents proposing milestone groupings need a
milestone object to propose).

## Goals

1. Give projects named cycles with start/end dates owning a set of issues.
2. Provide progress rollup (counts by status) plus burn-down computed from
   durable issue timestamps and activity, cached like the reference
   `progress_snapshot` so reads stay cheap.
3. Keep cycle membership orthogonal to workflow status, assignees, and
   execution: cycles observe work, they never gate wakes, locks, or
   budgets.
4. Let routines file into the active cycle and let agents propose cycle
   membership changes inside existing approval boundaries.

## Non-Goals

- Velocity estimation, story points, or capacity planning. Counts and
  burn-down only; estimation is a separate proposal if ever.
- Automatic scope changes at cycle boundaries (no auto-carryover, no
  auto-closing). Rollover is an explicit operator action.
- Replacing routines, project target dates, or the inbox. Cycles sit
  beside them.
- Cross-project cycles in phase 1. One project per cycle, like the
  reference.

## Proposed Model

### Phase 1: cycles table + membership + rollup API (schema + service)

- New `cycles` table (company scope): project id, name, description,
  start/end timestamps with timezone, owner references, archived flag,
  cached `progress_snapshot` JSONB. New `cycle_issues` link table
  (cycle, issue, company) with uniqueness guards.
- Progress computation: counts by workflow status over member issues plus
  burn-down series derived from `startedAt`/`completedAt`/`cancelledAt`
  and activity events. Snapshot cached on the cycle row, recomputed on
  membership changes and on a bounded schedule (not per read).
- Membership mutations (add, remove, move between cycles) as service
  operations with actor attribution and activity entries.
- Read API: cycle detail (members, rollup, snapshot) scoped per project.
  Migration is additive (two new tables only). No existing column changes.

### Phase 2: cycle progress surface (UI)

- Project cycle page: member list reusing issue-row patterns, progress
  rollup header, and a burn-down chart from the cached snapshot.
- Counts surface where operators already look (project headers, sidebar)
  following existing badge patterns.
- Rollover action: move unfinished members to a chosen next cycle as one
  attributed operation.

### Phase 3: integrations (follow-ups, one per surface)

- Routine step type filing created issues into the active cycle.
- Agent-proposed membership changes routed through existing approval
  flows (Self-Organization feedstock).
- Optional: cycle completion summaries reusing the continuation-summary
  document pattern.

## Open Questions for Maintainers

1. One project per cycle (proposed, like the reference) or cross-project
   programs from the start?
2. Should membership be exclusive (one active cycle per issue) or allow
   overlaps?
3. Burn-down source of truth: issue timestamps, activity events, or both?
   How fresh must snapshots be?
4. Do cycles need owners/permissions beyond project membership?
5. Should cycle end trigger anything (notifications, auto-rollover
   prompts), or stay purely observational in phase 1 and 2?
6. Timezone handling: per-cycle timezone like the reference, or instance
   local throughout?

## Risks

- A second grouping running beside projects, goals, and labels can confuse
  operators. Mitigation: cycles observe only — no gating of wakes, locks,
  budgets, or approvals — and the UI presents them as time views, not new
  ownership.
- Stale snapshots mislead. Mitigation: recompute on every membership
  mutation plus a bounded refresh schedule, with the snapshot timestamp
  always displayed.
- Scope creep into estimation and capacity planning. Mitigation: explicit
  non-goal with its own proposal gate.

## Alternatives Considered

- Project target dates plus labels for grouping (status quo extended).
  Rejected: one date cannot express iterations, and labels lack dates,
  rollups, and burn-down.
- Routines as iterations. Rejected: routines model recurrence ("every
  Monday"), not bounded windows with membership.
- Milestone fields directly on issues. Rejected: scatters the time-box
  across rows with no container for progress, ownership, or rollover.
- Doing nothing. Rejected: the roadmap names Work Queues explicitly, and
  time-boxed execution is the missing counterpart to continuous queues.
