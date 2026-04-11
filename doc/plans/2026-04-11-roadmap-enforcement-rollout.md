# Roadmap-First Enforcement Rollout Plan

Date: 2026-04-11  
Owner: CEO (policy), Engineering (implementation)

## Goal

Make roadmap items the parent unit of delivery and enforce traceability from roadmap item -> Paperclip issue -> delivery update.

## Enforcement Design

### 1. Canonical source

- CEO owns [`2026-04-11-roadmap.md`](./2026-04-11-roadmap.md).
- Every roadmap item has a stable ID (`RM-YYYY-QN-XX`).

### 2. Issue creation gate (Paperclip)

- Add required issue metadata fields:
  - `roadmapItemId`
  - `roadmapItemRef`
  - `exitCriteria`
- Block issue creation if roadmap metadata is missing.

### 3. Delivery update gate (Paperclip)

- Require each execution update/check-in to carry the same `roadmapItemId` as the linked issue.
- Block completion transitions when roadmap metadata does not match.

### 4. Exception path

- `RM-UNPLANNED` is allowed for urgent reactive work.
- Team must backfill a real roadmap mapping within 48 hours.

## Rollout Phases

### Phase 1 (day 0)

- Publish canonical roadmap file with IDs.
- Add roadmap metadata fields to issue flow.
- Add transition guards for missing or mismatched roadmap IDs.

### Phase 2 (days 1-7)

- Backfill active issues with roadmap IDs.
- Update in-flight work to include roadmap metadata.
- Track exceptions using `RM-UNPLANNED`.

### Phase 3 (week 2 onward)

- Weekly CEO roadmap review precedes issue triage.
- New issues without roadmap mapping are rejected.
- Treat unlinked active issues as process debt to clear weekly.

## Applying To Running Projects

### Backfill workflow

1. Export active Paperclip issues.
2. Map each issue to one roadmap ID.
3. Add `roadmapItemId`, `roadmapItemRef`, and `exitCriteria` to each issue.
4. Close duplicates or out-of-roadmap issues.

### Current work handling

1. For in-flight work, append matching roadmap metadata before marking complete.
2. If no roadmap item exists, use `RM-UNPLANNED` and backfill within 48 hours.

## Operating Cadence

1. CEO updates roadmap status/priority weekly.
2. Team triage creates/reorders issues from roadmap items.
3. Engineering review checks roadmap linkage before implementation review.

## KPIs

- Issue linkage coverage: `% active issues with valid roadmap ID`
- Delivery linkage coverage: `% active work items with matching roadmap ID`
- Unplanned ratio: `% completed items marked RM-UNPLANNED`
- Backfill SLA: `% RM-UNPLANNED items backfilled within 48 hours`

## Exit Criteria

1. New issue creation without roadmap mapping is blocked.
2. Completion transitions without roadmap mapping are blocked.
3. All active projects are backfilled and linked to roadmap items.
