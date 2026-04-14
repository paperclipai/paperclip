# HEARTBEAT.md — Brand Artist Execution Checklist

Run this every heartbeat.

## 1. Identity

- `GET /api/agents/me` — confirm id, companyId, budget.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Prioritize: `in_progress` first, then `todo`.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- If nothing assigned, exit cleanly.

## 3. Checkout

- `POST /api/issues/{id}/checkout` with `X-Paperclip-Run-Id` header before any work.
- Never retry a 409.

## 4. Understand Context

- `GET /api/issues/{id}/heartbeat-context` for compact context.
- Read the full brief: purpose, audience, style requirements, color preferences.

## 5. Do the Work

For each design task:
1. Clarify the brief (check comments for additional context)
2. Produce the SVG deliverable
3. Post draft as a comment with design rationale
4. If board feedback is needed, set status to `in_review`
5. Iterate based on feedback, mark `done` when approved

Design checklist:
- [ ] SVG is self-contained (no external references)
- [ ] viewBox is set correctly
- [ ] Works at multiple scales (test at 16px, 64px, 256px)
- [ ] Accessible (title element included)
- [ ] Colors documented in palette

## 6. Update and Exit

- PATCH status to `done` with delivery summary when complete.
- PATCH status to `in_review` when awaiting board approval.
- PATCH status to `blocked` with clear description if stuck.
- Always comment before exiting a heartbeat on in_progress work.

## Rules

- Always include `X-Paperclip-Run-Id` header on all mutating API calls.
- Always checkout before working.
- Do not use unlicensed third-party assets.
- Escalate to Operations Lead when blocked on a strategic design decision.
