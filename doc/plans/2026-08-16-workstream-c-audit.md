# Workstream C Audit — Board Chat & Chat-to-Work Resolution

**Author**: COO (2f49c205)
**Date**: 2026-08-16 02:55 UTC
**Status**: Audit Complete — Design Phase

## 1. Current State Assessment

### 1.1 Route: `server/src/routes/board-chat.ts` (402 lines) ✅ SHIPPED

| Aspect | Status | Notes |
|--------|--------|-------|
| POST /board/chat/stream endpoint | ✅ | Mounted under /api in app.ts |
| SSE streaming protocol | ✅ | start/status/chunk/done/error events |
| claude CLI invocation | ✅ | Board skill as system prompt |
| Conversation persistence | ✅ | "Board Operations" standing issue |
| Feature flag guard | ✅ | enableConferenceRoomChat |
| Deployment mode gate | ✅ | local_trusted only |
| Rate limiting | ✅ | 3 concurrent max |
| Timeout handling | ✅ | 120s with SIGTERM + cleanup |
| History injection protection | ✅ | Tagged turns `<turn role="...">` |
| Client disconnect handling | ✅ | Kills subprocess on SSE close |

### 1.2 UI: `ui/src/pages/BoardChat.tsx` (1020 lines) ✅ SHIPPED

| Aspect | Status | Notes |
|--------|--------|-------|
| Chat bubble UI | ✅ | User (blue right) / Agent (card left) |
| SSE stream rendering | ✅ | Token-by-token via content_block_delta |
| Welcome screen | ✅ | Typing animation + suggestion chips |
| Split-pane layout | ✅ | Chat + Agent Feed, resizable |
| Mobile responsive | ✅ | Sheet drawer for agent feed |
| Draft persistence | ✅ | Per-company sessionStorage |
| Scroll management | ✅ | Restore position, auto-scroll, jump-to-latest |
| Feedback voting | ✅ | Thumbs up/down via AgentBubbleActionRow |
| Sidebar link | ✅ | /board-chat → "Conference Room" |

### 1.3 Skill: `skills/paperclip-board/SKILL.md`

Not audited in detail. The board skill drives the Claude subprocess behavior. Needs review to ensure it can emit structured actions (create issue, create plan, record decision).

### 1.4 E2E Test: `tests/e2e/nux-phase4-screenshots.spec.ts`

Basic screenshot test exists for the board-chat page.

## 2. Refined Gap Analysis (Post-Skill Audit)

### 2.1 Chat-to-Work Resolution ⚠️ PARTIALLY IMPLEMENTED (Skill-Level)

**Key finding**: After auditing `skills/paperclip-board/SKILL.md`, the board skill **already** creates real Paperclip objects:

- Creates issues (hiring plans, task issues) via `POST /api/companies/.../issues`
- Creates/updates plan documents via `PUT /api/issues/{id}/documents/plan`
- Creates review gates via `POST /api/issues/{id}/plan/gates`
- Manages approvals (approve/reject/request revision)
- Captures memory records via `POST /api/companies/.../memory/capture`
- Queries memory for prior context
- Maintains a structured decision log on the Board Operations issue
- Presents results with clickable UI links

**What's missing (UI-level)**:
- Created objects are presented as formatted markdown with links, not as interactive "resolution cards"
- The `%%ACTIONS%%` structured signal protocol (already supported in route) is not used by the skill
- No visual distinction between "just chatting" and "created a work object"

### 2.2 Plan Integration ✅ SHIPPED (Skill-Level)

The board skill's "Plan Management" section includes:
- Create/update plan documents with metadata, sections, milestones
- List revisions and view diffs
- Create and resolve review gates (approve/reject)
- All accessible via the board chat interface

### 2.3 Memory Integration ✅ SHIPPED (Skill-Level)

The board skill's "Memory Operations" section includes:
- Capture facts with company scope (30d TTL)
- Semantic + full-text hybrid query
- List recent records
- Forget records
- Skill is instructed to query memory before answering questions about prior decisions

### 2.4 UI Resolution Cards ❌ NOT IMPLEMENTED

The only real gap: the UI doesn't visually highlight when the assistant creates a Paperclip object. The markdown responses contain links, but there's no:
- Resolution card component showing type badge (issue/plan/approval/memory)
- Inline action confirmation with object preview
- Visual separation between "response text" and "created object"

## 3. Resolution Flow Design

### 3.1 Structured Action Protocol

The board skill already emits %%ACTIONS%%{...}%%/ACTIONS%% structured signals (see stripActionSignals in board-chat.ts). These are currently stripped before persistence. Proposed: **surface these signals** through the SSE stream so the UI can render clickable resolution targets.

The protocol:
```
%%ACTIONS%%
{
  "resolution": {
    "type": "issue",
    "action": "create",
    "data": {
      "title": "Hiring Plan for Q4",
      "priority": "high"
    }
  },
  "decision": {
    "summary": "Approved Q4 hiring budget",
    "rationale": "Based on revenue projections"
  }
}
%%/ACTIONS%%
```

### 3.2 Resolution Types

| Type | Action | Target Object | Created Via |
|------|--------|--------------|-------------|
| issue | create/update | Issue | Board skill calls Paperclip API |
| plan | create/revise | Plan Document | Plan routes (Workstream A) |
| approval | record | Approval Gate | Plan review gates |
| knowledge | create | KB Article | Knowledge base (Workstream B) |
| memory | store | Memory Record | Memory adapter (Workstream B) |

### 3.3 UI Treatment

When the SSE stream delivers a structured %%ACTIONS%% block:
1. Parse the JSON in the UI
2. Render inline action cards after the agent's text bubble
3. Card shows: created object title, type badge, link to open
4. User can click through to the created object

### 3.4 Implementation Priority

1. **Parse %%ACTIONS%% in SSE stream** — surface structured signals to UI without stripping
2. **Render resolution cards in BoardChat.tsx** — show created objects as interactive cards
3. **Board skill enhancements** — teach the skill to emit structured actions for common flows
4. **Plan integration** — connect to plan routes when available
5. **Memory integration** — connect to memory adapter when available

## 4. Technical Debt / Observations

- The claude CLI path is hardcoded as "claude" — should be configurable
- The board skill is read from disk at runtime and cached — hot-reload would be useful during development
- No unit tests for the route itself (only feature-flag test exists)
- No error recovery if the spawned process crashes mid-stream beyond the 120s timeout
- The stripActionSignals function currently strips structured output before persistence, losing the resolution information

## 5. Next Steps

1. ~~Audit existing board-chat.ts implementation~~ ✅ DONE
2. Design chat-to-work resolution flow (this document)
3. Create implementation child issues for resolution flow
4. Board skill review and update
5. UI integration for resolution cards
