# Support Case Assessment: v0.4.0 Chat-to-Work Resolution Cards (Workstream C)

**Feature**: Board Chat (Conference Room) resolution cards — clickable inline cards that appear when the board assistant creates or updates Paperclip work objects
**Assessed by**: Support Engineer (88b72065)
**Date**: 2026-08-16
**Related**: BOARD-1, VOY-1188, VOY-1210, VOY-1263
**Release**: v0.4.0 (pre-release)
**Commit**: `0d4626e82e` (Workstream C), `75c6c27a41` (C-1 validation hardening)

## Feature Overview (User Perspective)

The Board Chat / Conference Room (`/board-chat`) lets operators converse with a board-level assistant that can manage Paperclip objects (issues, plans, approvals, knowledge articles, memory records). Previously, when the assistant created or updated an object, it would only mention it in text — users had to scan for links.

**Now, the assistant emits clickable resolution cards** that appear below the chat bubble when the assistant takes an action:

| Resolution Type | Badge Color | Example |
|---|---|---|
| Issue created/updated | Blue | "Created: Hiring Plan for Q4" with View link |
| Plan created/updated | Purple | "Updated: Launch Plan v2" with View link |
| Approval recorded | Green | "Approved: Launch Plan v2 — Approved" with View link |
| Knowledge article created | Amber | "Created: Onboarding FAQ" with View link |
| Memory record stored | Teal | "Noted: Q3 focus — European market" |
| Decision recorded | Yellow | "Decision: Prioritized European market for Q3" with rationale |

### How It Works

1. The user sends a message to the board assistant (e.g., "Create a task to research competitors")
2. The assistant processes the request and calls the Paperclip API to create/update work objects
3. At the end of its response, the assistant appends a structured `%%ACTIONS%%{...}%%/ACTIONS%%` block containing a JSON description of the created/updated object
4. The server parses this block, emits it as a typed SSE `action` event to the UI, and strips the raw markup from the persisted response
5. The UI renders a ResolutionCard component below the assistant's bubble, showing the object type, action (Created/Updated), title, and a "View" link when available
6. The raw `%%ACTIONS%%` markup is stripped from the stored comment — only the card remains visible

### Card Behavior

- **During streaming**: resolution cards appear below the streaming text as soon as the action event arrives (after the model finishes generating)
- **After persistence**: cards also render below the last persisted assistant comment (below the cleaned response)
- **Multiple cards**: if the assistant creates multiple objects in a single turn, multiple cards render
- **Decision-only cards**: when the assistant records a decision without a work object, a yellow "Decision" card appears with summary and rationale

## Feature Flag / Gating

The Board Chat (Conference Room) is gated behind:

- **Feature flag**: `enableConferenceRoomChat` in instance settings (default: `true`)
- **Deployment mode**: `local_trusted` only — not available in cloud/restricted deployments

Resolution cards only appear when the feature flag is enabled and the assistant actually creates/updates a work object. If the assistant only provides conversational text (no action), no cards render.

## Known Limitations & Edge Cases

| Limitation | Description |
|---|---|
| **One block per response (up to 10)** | The board skill emits a single `%%ACTIONS%%` block per response, but the server caps at **10 blocks max** per turn for safety. If the model emits more than 10 blocks, extra blocks are silently truncated. |
| **Malformed or invalid actions silently dropped** | Action blocks are validated against a strict Zod schema. Blocks with unrecognized resolution types, invalid actions, non-http(s) URLs, or oversized fields are silently skipped (logged server-side). The conversational text still persists normally. |
| **URL protocol restriction** | URLs in action data are restricted to `http:` and `https:` protocols only. Blocked protocols (javascript:, data:, file:) are rejected with a log warning. |
| **Field length limits** | Title fields are limited to 500 characters, ID fields to 200 characters, and rationale/decision summaries to 5000 characters. Oversized fields cause the entire action block to be skipped. |
| **Unknown keys stripped** | The Zod schema uses `.passthrough()` for action data, so unexpected keys from the model are stripped rather than causing errors. |
| **Raw markup briefly visible during streaming** | While the model is still generating, the raw `%%ACTIONS%%{...}%%/ACTIONS%%` markup may appear as plain text in the streaming bubble. This is expected — it clears when the stream completes and the cleaned response persists. |
| **Cards reset on new message** | When the user sends a new message, any action events from the previous turn are cleared. Cards are per-turn only and do not persist in the conversation history. |
| **"View" link only when `data.url` provided** | The resolution card's "View" link only appears if the assistant includes a `url` in the action data. If omitted, the card shows the title without a link. |
| **No update cards for some object types** | The `update` action is defined for issues and plans but not for approvals, knowledge, or memory. Support should not expect to see "Updated" cards for those types. |
| **Feature is local_trusted only** | The Conference Room is only available when the deployment mode is `local_trusted`. Cloud deployments do not have this feature. |

## Troubleshooting

### "The assistant didn't show a resolution card"

| Possible cause | Check |
|---|---|
| The assistant only provided conversational text — no object was created/updated | Review the assistant's response. If it merely answered a question without creating a work object, no card is expected. |
| The feature flag is disabled | Check instance settings: `enableConferenceRoomChat` must be `true`. |
| Deployment mode is not local_trusted | The Conference Room (and thus resolution cards) is only available in `local_trusted` deployments. |
| The assistant tried to create an object but failed | Check the chat response for error messages. If the Paperclip API call failed, no action signal is emitted. |
| Malformed JSON in the action block | If the model output contains broken JSON inside `%%ACTIONS%%`, it is silently dropped. No error is surfaced. |
| The stream hasn't finished yet | Cards appear after the model finishes generating (after the `action` SSE event). Wait for the stream to complete. |

### "I see raw `%%ACTIONS%%` text in the chat"

- **During streaming**: this is expected. The raw markup is part of the model's output and appears while the text is being generated token-by-token. Once the stream completes, the raw markup is stripped from the persisted comment and replaced with resolution cards.
- **After the stream ends**: if raw markup is still visible after the stream ends, this is a bug. The server should have stripped it before persisting. Escalate to engineering.

### "The card shows the wrong type/action"

- The card type and action come from the model's JSON block. If the model mis-identifies the action (e.g., says `"type": "issue"` when it created a plan), the card reflects that error.
- This is a model behavior issue, not a server/UI bug. Report the conversation as a support case for analysis.

### "No 'View' link on the card"

- The "View" link only appears when the assistant includes a `data.url` field in the action JSON. Some actions (like memory captures) may not have a navigable URL.
- If the assistant created an issue without providing a URL, the card shows the title but no link. The user can navigate to the issue manually.

## Error States

| Scenario | User Experience | Resolution |
|---|---|---|
| **Model generates invalid JSON inside %%ACTIONS%%** | No card appears; raw markup is stripped; conversational text persists normally | Support can ignore — no data loss. Consider reporting the conversation for model quality analysis. |
| **Model emits an action block that fails Zod validation** | The block is skipped; a server-side warning is logged (`extractActionSignals: skipping malformed action block`). No card renders; conversation persists | Check server logs for the schema issue list to confirm why the block was rejected (bad type enum, non-http(s) URL, or oversized field). Report conversation for model quality analysis. |
| **Model emits more than 10 action blocks** | Only the first 10 blocks are processed; a server-side warning is logged (`response exceeds max blocks (10) — truncated`) | Unexpected model behavior — report for analysis. User sees cards only for the first 10 blocks. |
| **%%ACTIONS%% block truncated by 120s timeout** | If the model is mid-generation when the 120s timeout fires, the incomplete block is stripped. Partial action signals may not parse. | User may see a partial response with no card. Retry the request with a shorter ask. |
| Multiple %%ACTIONS%% blocks in one response | The server's `extractActionSignals` parses ALL blocks, so multiple cards render. However, the skill instructs the model to emit only one block per response. Multiple blocks is unexpected behavior — report for analysis. | Cards render correctly even with multiple blocks. No user-facing error. |
| SSE connection drops during action event delivery | Action events are delivered as part of the SSE stream. If the connection drops before the `action` event, the card does not render. The persisted comment still has the markup stripped. | User sees the cleaned response without cards. Refreshing the page loads the comment (without raw markup) but cards do not re-render. This is a known limitation. |

## Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Resolution card causes UI error (crash, blank page) | Critical | Escalate to CTO immediately — UI error in core chat surface |
| Raw %%ACTIONS%% markup persists in saved comments | High | Escalate to Staff Engineer — server-side stripping failure; user sees raw JSON |
| Action events delivered to wrong company/issue | Critical | Escalate to CTO — potential cross-tenant leak (though authorization layer should prevent this) |
| Card shows wrong data (wrong issue ID, wrong title) | Medium | Report the conversation; likely model behavior issue, not code bug |
| Feature flag `enableConferenceRoomChat` not taking effect | Medium | Escalate to Staff Engineer — verify flag persistence and route guarding |
| "View" link points to wrong URL | Medium | Report conversation for model quality analysis — likely incorrect `url` in action data |

## Related Documentation

- [v0.4.0 Release Notes](../releases/v0.4.0-alpha-deep-planning.md)
- [Deep Planning Support Case Assessment](support-case-v0.4.0-deep-planning.md)
- [Memory & Knowledge Support Case Assessment](support-case-v0.4.0-memory-knowledge.md)
