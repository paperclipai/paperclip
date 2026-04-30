---
schema: agentcompanies/v1
kind: skill
slug: g3-alignment
name: G3 — CEO Alignment Gate
description: CEO checks that a piece of work (course, blog, code change) aligns with the original ticket + the company strategy. Catches scope creep before G4 (human).
version: 0.1.0
license: MIT
sources: []
---

# G3 — CEO Alignment Gate

Used by `ceo`. Triggered when work hits `awaiting-g3` after passing earlier gates (G0 content, G_code, G2 QA).

## API context (Docker stack 2026-04-30)

- Base: `http://localhost:3100` (or `http://host.docker.internal:3100` from inside containers)
- Active company: `Koenig AI Academy` · companyId `2a77f89b-33f0-4133-a20c-77ddaac5e744`
- Auth: bearer token (board API key) supplied via env `PAPERCLIP_BOARD_TOKEN` — DO NOT hardcode in comments

The exact PATCH for PASS:
```bash
curl -sX PATCH "http://localhost:3100/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done","metadata":{"publish_state":"ready","g3_passed_at":"'"$(date -u +%FT%TZ)"'"}}'
```

For high-stakes routing to G4:
```bash
curl -sX PATCH "http://localhost:3100/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_review","metadata":{"publish_state":"awaiting-g4","g3_passed_at":"'"$(date -u +%FT%TZ)"'"}}'
```

For BLOCK:
```bash
curl -sX PATCH "http://localhost:3100/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress","metadata":{"publish_state":null,"g3_blocked_at":"'"$(date -u +%FT%TZ)"'"}}'
```

The publish-action.sh cron polls `status='done' AND metadata.publish_state IN ('ready','g4-approved')` every 5 min. Setting `publish_state="ready"` is what triggers deploy.

## Procedure

1. **Read the original ticket** — what did Vardaan or you (CEO) ask for? What were the success criteria?
2. **Read the work product** — the vault note, the markdown chapter, the merged PR, etc.
3. **Read the budget consumed** — `GET /api/costs/by-task?id=<ticket>` — vs `budget_estimate` in the ticket
4. **Check 5 questions:**
   - Does the work product match the ticket's success criteria? (Y/N each)
   - Did scope creep beyond the ticket? (Y/N)
   - Did budget overrun materially (>1.5×)? (Y/N)
   - Are there obvious red flags QA didn't catch? (Y/N)
   - Is this consistent with company strategy (V1 vendor scope; content-first; brand voice)? (Y/N)
5. **Decide**:
   - **PASS (default)** — keep status `done`, PATCH `metadata.publish_state = "ready"`. publish-action cron detects `status=done + metadata.publish_state=ready` and deploys within 5 min. (**Do NOT set status to "published-ready" — that value is not in the API enum and returns 400.**)
   - **PASS + high-stakes** — if ticket has `high_stakes: true` in description metadata, set status `in_review` + `metadata.publish_state = "awaiting-g4"` and route to human (g4-routing skill). Reserved for: (a) new course launches, (b) competitor / vendor claims, (c) any post Vardaan flagged at ticket creation.
   - **BLOCK** — flip status back to `in_progress` (or the relevant earlier gate's equivalent) with a specific reason

6. **Comment on the ticket**:

```
✅ G3 PASS · KOE-123 · vault/blogs/2026-04-30-claude-code-billing/draft.md
- Matches original ticket success criteria ✓
- Budget: $0.78 spent / $1.00 estimated ✓
- No scope creep · Strategy aligned (V1 vendor scope ✓; brand voice ✓)
- high_stakes: false → metadata.publish_state=ready (status stays done; auto-publish; live in <5 min)
```

OR (high-stakes path)

```
✅ G3 PASS · KOE-456 · vault/courses/mcp-server-scaffolding/...
- Matches ticket success criteria ✓ · Budget: $1.78 / $2.00 ✓
- high_stakes: true (new multi-chapter course launch) → awaiting-g4 (Vardaan)
- Routing → @ceo g4-routing
```

OR

```
❌ G3 BLOCK · KOE-123 · scope creep
- Ticket asked for course-delta on Module 4 (connectors)
- Work product modifies Module 5 (multi-tool flows) too
- Budget overrun: $1.40 spent / $1.00 estimated (40% over)
- Route back: @chief-content for ticket split or trim
```

## Inputs

- Ticket text + success criteria
- Work product (vault file or PR)
- Cost data

## Outputs

- A PASS or BLOCK comment + status flip
- If PASS + non-high-stakes → status stays `done`, PATCH `metadata.publish_state="ready"` (publish-action.sh cron deploys within ~5 min)
- If PASS + `high_stakes: true` → status `in_review` + `metadata.publish_state="awaiting-g4"`, hand to g4-routing skill (email + Slack/Teams + Paperclip queue)

## Never do

- Never approve work that doesn't match ticket success criteria — even if "the work is good"
- Never auto-approve based on prior G0/G_code/G2 alone — those gate quality, not alignment
- Never skip cost check; budget overruns matter
- Never let scope creep through "this time"

## Escalation

- Work product is obviously off-strategy (e.g., a course about a vendor we haven't approved) → BLOCK + ping the chief who dispatched
- 3+ G3 blocks for the same chief in a week → flag in next weekly retro

## Budget

Per-task cap $0.50.
