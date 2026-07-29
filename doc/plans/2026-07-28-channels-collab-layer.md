# Channels Collab Layer

Date: 2026-07-28  
Status: Implementation plan (active)

## Summary

Slack/Discord-like **channels** inside Paperclip. **Project = channel**, **task = root message**, **updates/HITL/runs = thread**. Issues remain the execution contract (checkout, budgets, liveness). Buzz is UX inspiration only.

Canonical detailed design: Cursor plan `channels_collab_layer` (grill decisions locked).

## Grill decisions

| Topic | Decision |
|-------|----------|
| Child tasks | New roots + link card in parent thread |
| No projectId | Board-only until projected |
| Membership | All humans + agents; mute; assign auto-add |
| Wake | @mention, human-in-assignee-thread, HITL resolve |
| Move project | Move root+thread; stub in old channel |
| Completed | Hidden by default |
| Home | Remember last; new+project → Channels |
| Freeform | Allowed, demoted notes |
| Composer | Ask + Plan + Work |
| Busy mention | Queue + system line |
| Backfill | Eager channels; lazy roots |
| Needs you | Keep + Decisions (same Attention) |
| Ship | New companies on; existing opt-in |

## Schema (v1)

- `companies.channels_enabled` boolean (default false; new companies set true)
- `channels`, `channel_members`, `channel_messages` (see `packages/db/src/schema/channels.ts`)

## Non-goals

Buzz/Nostr, nested threads, email/push, replacing Decisions/approvals SoT.
