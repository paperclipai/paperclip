# Roadmap Backfill (Active Work)

Date: 2026-04-11

## Objective

Backfill all currently active Paperclip issues so each one links to exactly one roadmap item ID.

## Backfill Procedure

1. Export all active issues from Paperclip.
2. For each issue, assign one roadmap item ID from `2026-04-11-roadmap.md`.
3. Update issue metadata:
   - `roadmapItemId`
   - `roadmapItemRef`
   - `exitCriteria`
4. If no roadmap item fits, assign `RM-UNPLANNED` and add rationale.
5. Within 48 hours, replace `RM-UNPLANNED` with a concrete roadmap ID or create a new roadmap item.

## CEO Triage Rules

1. High-confidence mappings can be applied immediately.
2. Ambiguous mappings require CEO decision before work continues.
3. Duplicate issues should be merged under one roadmap-linked parent issue.
4. Out-of-roadmap work should be paused or explicitly marked `RM-UNPLANNED`.

## Completion Criteria

1. 100% of active issues include roadmap metadata.
2. 0 issues remain unmapped.
3. All `RM-UNPLANNED` entries have owner + deadline for backfill.
