# Pelergy Marketing Workflow v1 (Paperclip Trial)

## Goal
Validate that Pelergy marketing operations can run as a visible, approval-gated workflow inside Paperclip.

## Workflow Stages
- Backlog
- Drafting
- Internal Review
- Approval Pending
- Approved
- Scheduled
- Published

## Practical Status Mapping in current Paperclip UI
Until custom stage taxonomy is implemented, use these built-in issue statuses:
- `todo` => Backlog
- `in_progress` => Drafting
- `in_review` => Internal Review
- `blocked` => Approval Pending / Needs edits
- `done` => Published (only after URL proof exists)

Approved/Scheduled are tracked via linked approval state + task metadata.

## Required Metadata per Marketing Item
Include these fields in issue description/body:
- Lane (content_lane)
- Content type (content_type)
- Dependencies (internal issue IDs or external blockers)
- Due window (start/end + timezone)
- Platform: LinkedIn | X | Website
- Post Type: Insight | Case Study | Launch | Thread | Blog
- Draft Text
- Image URL(s) + alt text + rights note
- CTA
- Target Publish Date/Time
- Owner
- Proof URL (required before marking Published)

## Approval Rules (v1)
1. Any outbound/public post requires linked approval.
2. Review actions: Approve / Needs edits / Reject.
3. Only approved items can move to Scheduled.
4. Publish completion requires proof URL.

## Seeded Test Data (2026-03-22)
Created in local Pelergy company (`PEL`):
- `PEL-2` — LinkedIn teaser (Backlog/todo)
- `PEL-3` — X thread draft (Drafting/in_progress)
- `PEL-4` — Website post (Internal Review/in_review)
- Approval `12f9be1f-0a80-42d0-9e43-84cb2524321c` linked to `PEL-1` with image metadata for review testing

## Next Upgrade (v1.1)
- Add dedicated custom workflow stage field in issue schema
- Render image preview thumbnails in ApprovalDetail and Issue cards
- Add reusable "Pelergy marketing item" create template in UI
- Add automatic transition hooks:
  - approval approved => issue moves to Scheduled
  - approval rejected/revision_requested => issue moves to blocked with reason
