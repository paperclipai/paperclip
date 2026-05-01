---
schema: agentcompanies/v1
kind: skill
slug: check-sibling-tickets
name: Check Sibling Tickets (Generic Dedup Guard)
description: Generic pre-fan-out de-dup check used by ALL chiefs (Content, Marketing, Engineering, Research) before they create child tickets. Scans for in-flight siblings on the same vendor + topic + content_type. Closes the root cause behind the April 2026 Claude Security Beta cluster (11 child tickets under 3 different parent IDs, all about the same release).
version: 0.1.0
license: MIT
sources: []
---

# Check Sibling Tickets

Used by `chief-content`, `chief-marketing`, `chief-engineering`, `chief-research`. Triggered **before** any chief creates a child ticket via `dispatch-content-task`, `dispatch-engineering-task`, `dispatch-seo-task`, or `dispatch-vendor-watch`.

Why this exists: April audit found the Claude Security Beta cluster — 11 child tickets under 3 different parent IDs (b3a4ffd0, 781ec769, 461cc400) created by Chief Content within a 30-minute window. Each parent got its own author + reviewer + slide-producer triplet. No de-dup check before fan-out. Same pattern would emerge with any HOT topic that surfaces in the daily brief from multiple researcher angles.

## Procedure (call this BEFORE creating any child ticket)

1. **Compute the dedup key** for the candidate child ticket from:
   - `vendor_tag` (anthropic / openai / google / community)
   - `topic_slug` — slugify the ticket title's first 4 keywords (e.g. "claude security beta devsecops" → `claude-security-beta-devsecops`)
   - `content_type` (blog / course / course-chapter / code / research-deep-dive / image-gen / slide-audio / etc)
   - For course-chapter type: also include `course_slug` and `chapter_num`

2. **Query open siblings** via Paperclip API:
   ```
   GET /api/companies/{companyId}/issues?limit=200&assignee={candidate_assignee}
   ```
   Filter the response client-side for any open ticket where:
   - `state IN ('todo', 'in_progress', 'in_review', 'blocked', 'awaiting-g0', 'awaiting-g3')`
   - `metadata.dedup_key == candidate_dedup_key` OR title-similarity > 0.85 (use a simple word-overlap heuristic)
   - `created_at > now - 24h` (older sibling tickets that haven't moved are likely stuck — see `recover-stuck-tickets` skill)

3. **Decision matrix** based on what you find:

   | Found | Action |
   |---|---|
   | 0 siblings | Create the new ticket. Stamp `metadata.dedup_key` for future siblings to find. |
   | 1 sibling, same chief, healthy (last activity < 4h) | DO NOT create. Comment on the existing sibling: "Re-prioritized: <reason new request matters>". |
   | 1 sibling, different chief | Cross-team conflict. Create the new ticket BUT add `metadata.coordinate_with: KOEA-XXX` and ping that chief. |
   | 1 sibling, same chief, stuck (no activity > 4h) | Run `recover-stuck-tickets` on the existing sibling FIRST, then re-evaluate. |
   | 2+ siblings | DO NOT create. Comment on the *oldest* with `metadata.is_canonical: true`; comment on others with `metadata.superseded_by: KOEA-OLDEST` and PATCH them to `cancelled`. |

4. **Stamp the canonical ticket** with `metadata.dedup_key` so the next call to this skill finds it. Schema:
   ```json
   {
     "metadata": {
       "dedup_key": "blog/anthropic/claude-security-beta-devsecops",
       "is_canonical": true,
       "siblings_at_creation": []
     }
   }
   ```

5. **Log the decision** to `vault/_audit/sibling-dedup-log.jsonl` (append-only). Helps Vardaan see the volume of duplicates the system would have created.

## Inputs

- The candidate ticket draft (title, vendor_tag, content_type, parent_id)
- Paperclip API token + companyId

## Outputs

- A boolean: `should_create_new_ticket`
- If false: a pointer to the canonical sibling ticket
- An audit log entry

## Never do

- Never silently dedup tickets Vardaan created manually (`origin_kind='manual'` + `created_by_user_id`). His intent is the source of truth — surface a warning instead.
- Never cancel a sibling that is in-progress or has author output already in vault. Prefer "fold into canonical" via comment.
- Never run this skill more than once per parent fan-out — caching the dedup_key result is safe within a single dispatch round.

## Wiring per chief

Add to each chief's `dispatch-*` skill flow:

```
Step 1: Build the candidate ticket spec
Step 2: CALL check-sibling-tickets(spec)
Step 3: If should_create_new_ticket == false:
          - Comment on the canonical sibling
          - Return without creating new ticket
        Else:
          - Create the ticket
          - Stamp metadata.dedup_key
          - Update canonical's siblings_at_creation
```

## Budget

Per call cap $0.02 (a single read query + a few API calls; should round to <100 tokens of model time).
