---
date: 2026-05-01
author: vardaan
type: decision
status: locked
---

# Author pipeline + content policy — comprehensive fixes

Three policy changes locked this session, all enforced via skill + SOUL edits + the G0 reviewer gate. Combined with the earlier `2026-05-01-blog-skip-g4.md` decision, they form the new author pipeline contract.

## 1. Mandatory researcher-grounding for authors

**Rule:** Before drafting a single word, both `content-author` and `blog-author` MUST:
- Read `vault/research/_daily/<YYYY-MM-DD>.md` (Editor's daily brief)
- Read the per-vendor researcher note(s) at `vault/research/<vendor>/<YYYY-MM-DD>.md`
- Embed at least **2 `[[wikilink]]` references to those research notes** in the draft body

If the brief or vendor note doesn't cover the topic, escalate to chief-research with a deep-dive request. **Do not scrape the web as a workaround** — that's what broke things in April.

**Why:** The April content audit showed bimodal output quality (4.6 with research, 3.0 without). Authors were bypassing the daily brief and re-doing web research themselves; the source-of-truth chain was broken. With grounding, the Editor's daily brief becomes a real artifact, not a CEO-only memo.

**Enforcement:** Content Reviewer's G0 gate now has a 5th dimension — **Research Grounding** — and **BLOCKs any draft missing the wikilinks**. The block message tells the author exactly which note to read.

**Files:**
- `agents/blog-author/SOUL.md` (collaboration section rewritten)
- `agents/content-author/SOUL.md` (collaboration section rewritten)
- `agents/content-reviewer/AGENTS.md` (added Research Grounding as dim #5; updated approval message format)

## 2. Blog length — strike zone moves up

**Rule (LOCKED 2026-05-01):**
- **Default blog length: 1,800-3,500 words** (target 2,200-2,800)
- **Course-chapter length: 1,200-2,500 words each**
- **Breaking-news lane: 800-1,500 words** — only when ticket has `news-flash: true`
- Anything outside these bands needs explicit chief-content approval at ticket-creation time

**Why:** Vardaan flagged that blogs are too short — current strike zone was 800-1,500w (set by V2-2b) but most posts now have enough source-material depth to warrant 2,000-3,000w. Short blogs get less Google + AI-search traction and don't earn citations; depth is the moat.

**Enforcement:** Content Reviewer **BLOCKs any blog draft under 1,800w** that isn't flagged `news-flash`.

**Files:**
- `agents/blog-author/SOUL.md` (rule #4 rewritten)
- `agents/content-author/SOUL.md` (added rule #6 for length)
- `agents/content-reviewer/AGENTS.md` (Completeness dimension rewritten with hard word-count gate)

## 3. Two Gemini Enterprise courses merged

**Action:** Merged `gemini-enterprise-agent-platform-hands-on-tour` (4 written intro chapters) into `gemini-enterprise-agents` (canonical, 7-chapter production-focus outline).

- 4 chapter `.md` files moved into the canonical course directory
- Hands-on-tour course directory archived to `vault/_dedupe-archive/2026-05-01/courses/`
- Canonical outline updated with merge notice + action items for course-author

**Course-author follow-up:**
- Rewrite Ch1, Ch2, Ch4 to fit production focus (currently they're intro-level)
- Insert net-new Ch3 (RAG and grounding)
- Rename current Ch3 to Ch4 (multi-agent orchestration) and rewrite for production
- Move "comparing to Claude SDK and Cloudflare" content (current Ch4) to an appendix or fold into Ch1
- Write Ch5 (security), Ch6 (observability), Ch7 (scale + cost) from outline

**Files:**
- Moved: `vault/courses/gemini-enterprise-agents/0{1,2,3,4}-*.md`
- Edited: `vault/courses/gemini-enterprise-agents/outline.md` (merge notice + action items)
- Archived: `vault/_dedupe-archive/2026-05-01/courses/gemini-enterprise-agent-platform-hands-on-tour/`

## Open follow-ups (not done this session)

1. **Watchdog re-credential** — sub-agent running in background; will report what credentials need re-issuing and what permission-model change unblocks the cost circuit-breaker.
2. **Open-tickets sweep + Claude Security Beta cluster dedup** — sub-agent running with Paperclip API access; will cancel redundant tickets and unblock stuck ones.
3. **Langfuse ClickHouse migration** — single-node fix needed; either downgrade or rewrite migration to non-replicated DDL.
4. **Sibling-dedup contract for Chief Content** — root-cause for Q1 (no de-dup before child fan-out). New skill needed: `check-sibling-tickets` that scans for same-vendor-topic siblings before creating children.
5. **Dashboard ⇄ YAML reverse-sync** OR formal demotion of `.paperclip.yaml` to documentation-only. Vardaan's dashboard edits keep winning silently; YAML drift accumulates.
6. **GPT-5.5 hero image** — `2026-04-30-gpt-5-5-in-codex/draft.md` has frontmatter `hero_image: auto:flux` but no image was generated and no R2 asset exists. The image-gen skill never fired for this draft. Either chief-content didn't dispatch it, or the frontmatter-wired-mode trigger is broken. Worth a 10-minute manual retry to test.
7. **Re-trigger image-gen for blogs missing hero images** — many drafts have `auto:flux` sentinels with no resolved image.

## Verification

- Type check on the academy frontend is unaffected (these are vault + skill changes, no frontend code touched).
- Vercel rebuild from last push (`4e63eff`) is mid-flight; should bring `claude-security-beta-devsecops` blog live as part of the listing.
- Paperclip server was restarted earlier this session, so the new SKILL.md edits are loaded.
