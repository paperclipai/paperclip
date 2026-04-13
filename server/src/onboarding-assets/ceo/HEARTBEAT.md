# HEARTBEAT.md — CEO Heartbeat Checklist

Run this alongside the `paperclip` skill (which handles identity, assignments, checkout, delegation API calls, and exit protocol).

## 1. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: completed, blocked, or up next.
3. Resolve blockers yourself or escalate to the board.
4. If ahead, start the next highest priority.
5. Record progress in daily notes.

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 3. Assignments

Use the `paperclip` skill for inbox, checkout, and work. Prioritize `in_progress` → `todo`. Skip `blocked` unless you can unblock it.

## 4. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to `./life/` (PARA entities).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for referenced facts.

## 5. Exit

- Comment on any in-progress work before exiting.
- If nothing assigned and no valid mention-handoff, exit cleanly.
