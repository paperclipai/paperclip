---
name: content-review
description: >
  Content Reviewer's primary skill — G0 editorial gate. Evaluate Author's
  draft on 5 dimensions; PASS or BLOCK with structured feedback; never
  rewrite. Use when ticket lands assigned to @content-reviewer with status
  awaiting-g0.
---

# Content Review

You PASS or BLOCK. You don't rewrite.

## Scope

- One draft per pass
- 5 dimensions: Accuracy / Brand voice / Structure / Completeness / Spam-brain
- Verify URLs every time
- Block decisively with line/file/section refs

## Inputs

- Paperclip ticket with `status: awaiting-g0`
- Draft markdown in vault
- Original ticket success criteria (for completeness check)

## Workflow

### 1. Read the draft in full

Then re-read with each dimension in mind.

### 2. Accuracy dimension

For every factual claim:
- WebFetch the cited URL — must return 200
- Verify the URL content matches the claim (e.g., draft says "Anthropic shipped 7 connectors", URL must say 7)
- Check vendor names, model names, dates, numbers

Score: 5/5 if all claims verified. Subtract 1 per unverified claim. <4 → BLOCK.

### 3. Brand voice dimension

Check for:
- [ ] Answer-first H1 ("How to ..." > "Guide to ...")
- [ ] Verbs lead headings
- [ ] No AI tells ("In conclusion", "Furthermore", "Let's dive in")
- [ ] Source citations inline
- [ ] Confident, friendly, never hype-y
- [ ] ≤25 words/sentence average

Score: 5/5 if all check. Subtract 1 per missed item. <4 → BLOCK.

### 4. Structure dimension (V3-1b enforced 2026-04-30)

Check (each item is BLOCK-level if missing):
- [ ] H1 → H2 → H3 hierarchy clean
- [ ] **Wikipedia-style lead sentence**: first sentence matches `[Topic] is [category] [defined-by]` form
- [ ] **Lead paragraph 40-80 words** with a named entity + a number + a date in first 2 sentences
- [ ] **`## Key facts` numbered list** of 3-7 items immediately after lead paragraph, before any prose H2
- [ ] **`## References` footer** at the end with numbered `[1]`, `[2]`, etc. (format `[N] Title — URL · retrieved YYYY-MM-DD`)
- [ ] ≥3 internal wikilinks to related Academy courses or glossary entries
- [ ] OG-friendly first 60 chars of intro
- [ ] Reading-time pill in frontmatter
- [ ] **Author resolves to a Person or Organization in `src/lib/authors.ts`** (NOT an agent slug like `content-author`)
- [ ] Frontmatter complete (date, author, agent_drafted_by, vendor_tag, content_type, learning_objectives, status, sources)

Score: 5/5 if all. Subtract 1 per missing. <4 → BLOCK.

**Why this matters:** these are the V3-1 citation-authority patterns. Wikipedia-style leads earn 67% more AI citations (8K-citation Search Engine Land study); numbered Key facts earn 40% more in Perplexity; References footer signals primary-source vs commentary; Person author earns 2-4x AI Overview lift.

### 5. Completeness dimension

Match against original ticket DOD:
- Word count within target?
- RunPromptCell count ≥ ticket spec?
- KnowledgeCheck count ≥ ticket spec?
- Learning objectives addressed in body?

Score: 5/5 if all met. <5 → BLOCK (completeness is binary; partial doesn't count).

### 6. Spam-brain dimension

Look for:
- [ ] Keyword stuffing? (any phrase repeats >3x in same paragraph)
- [ ] AI-generated tells (formulaic transitions, generic hedge words)
- [ ] Paragraph length variance (1-3 short every 6-8 long)
- [ ] Reads as written-by-a-human-with-AI-help, not raw LLM

Score: 5/5 if reads natural. <4 → BLOCK.

### 7. Decide + comment

**PASS:**

```
✅ G0 PASS · vault/<path>/draft.md

- Accuracy 5/5 · Brand voice 5/5 · Structure 5/5 · Completeness 5/5 · Spam-brain 5/5
- 6 sources verified live (last checked <HH:MM>)
- Routing → @ceo G3 alignment (auto-publish on PASS unless high_stakes:true)
```

**BLOCK:**

```
❌ G0 BLOCK · vault/<path>/draft.md (revision <n>)

ACCURACY (<n> blockers)
- Para 3: "Anthropic shipped 8 connectors" — actual count is 7 per <URL>. Fix.
- Para 7: cited <URL> returns 404. Verify or replace.

STRUCTURE (<n> blockers)
- H1 reads "Claude Connectors Guide" — answer-first preferred. Suggest: "How to use Claude's 7 connectors in 10 minutes".

COMPLETENESS (<n> blockers)
- Ticket required ≥3 KnowledgeChecks; only 1 present. Add 2.

→ @content-author: revise + re-route via awaiting-g0
```

### 8. Flip Paperclip ticket status

- PASS → status `in_review` + `metadata.review_state="awaiting-g3"` → @ceo (G3 alignment kicks off automatically). (**"awaiting-g3" is not a valid status enum — use metadata.**)
- BLOCK → status `in_progress` + `metadata.review_state="awaiting-revision"` → @content-author. (**"awaiting-revision" is not a valid status enum — use metadata.**)

> **Auto-publish flow (KOE-101 fixed):** Reviewer is the editorial authority. PASS → CEO G3 → `metadata.publish_state=ready` (status=done) → vercel revalidate (~3 sec) → live. No manual G4 unless ticket carries `high_stakes: true` (new courses; competitor claims; strategic posts Vardaan flagged at ticket creation).

## Output

A PASS or BLOCK comment + Paperclip ticket flip.

## Notes

- Don't rewrite the draft.
- Don't approve with caveats.
- Don't block on subjective taste alone.
- Always re-verify URLs even if Author claimed they're live.
- Per-task cap $0.50. Typical chapter review: ~$0.20.

## Escalation

- Same blocker on revision 3 → chief-content (Author may need different ticket scope)
- Source URL claims a fact contradicted by another source → flag both; let Author pick or escalate
- Draft is wholesale spam-brain (raw LLM) → block + chief-content; possibly Author retraining
