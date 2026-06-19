---
name: paperclip-distill
description: Use when an operation issue is a Paperclip cursor-window, distill, or backfill — `operationType: "distill"` or `"backfill"` and the body references a Paperclip source bundle for a project or root issue. Turn raw Paperclip activity into a wiki-insightful project page, decisions log, and history note. This skill exists specifically to replace the stiff, datestamp-heavy templated output that the deterministic distiller produces.
---

# Paperclip Distill

Distill Paperclip project, issue, comment, and document activity into durable wiki pages. The success criterion is **wiki-insightful, not procedural**: a reader who has never seen Paperclip should learn what the project is, what was decided, what is at risk, and what the current state is — without scanning a list of `## [YYYY-MM-DD]` headers.

## When this skill is needed

- Cursor-window distillation: the routine fed you a bounded source bundle of recent Paperclip activity for one project or root issue.
- Backfill: the user asked to seed the wiki with the historical activity of a project or root issue. Source window may be wide.
- Manual `distill-paperclip-now` request from the UI.

If the operation issue is `operationType: "ingest"` (raw file) or `operationType: "query"`, this is the wrong skill — use `wiki-ingest` or `wiki-query`.

## Destination space

In Phase 1, every Paperclip distill, backfill, and cursor-window operation writes into the
default wiki space. The operation issue should always carry `spaceSlug: "default"`. If an
operation issue passes any other slug, stop and surface the mismatch in a comment — do not
write Paperclip-derived pages into a non-default space.

This rule is destination-only. The Paperclip source scope (which projects, root issues,
comments, documents are read) is set elsewhere in the operation issue and is independent of
the destination.

## Inputs

- A Paperclip source bundle (issue list, comment refs, document refs, source hash, cursor window).
- An existing or planned `wiki/projects/<slug>/standup.md` page path.
- An existing or planned `wiki/projects/<slug>/index.md` page path.
- The operation issue's target `wikiId`, `spaceSlug`, space root, and the target space's `AGENTS.md` for page conventions.
- The current `wiki/projects/<slug>/standup.md`, `wiki/projects/<slug>/index.md`, `decisions.md`, and `history.md` if they already exist (so you write a *patch*, not a rewrite).

## Paperclip Asset Gate

Do not treat Paperclip assets/attachments or issue work products as source text for this skill.

- Allowed Paperclip body text: issue descriptions, comment bodies, document bodies.
- Assets/attachments are metadata-only until a separate approved extraction policy exists.
- Work products are metadata-only until a separate approved extraction policy exists.
- Never fetch `/api/assets/:id/content`.
- Never dereference a work-product `url`, preview URL, artifact URL, or other linked destination from this skill.
- If an operator asks for attachment/work-product content distillation, stop and point them at the Phase 5 asset/work-product security gate policy instead of improvising.

## Anti-patterns to avoid

The deterministic templating this skill replaces produced these failure modes — do not reproduce them:

1. **Datestamp-as-section-header.** Lines like `## [2026-04-15] paperclip-distill | proposed` belong in `wiki/log.md`, not in the project page. The project page is durable knowledge; the log is the audit trail.
2. **Procedural status lists.** `Issue mix: 3 todo, 5 in_progress, 2 done` tells the reader nothing they could not read off Paperclip directly. State *what is happening and why it matters*, then cite the issues that constitute the evidence.
3. **One-line-per-issue dumps.** A page that is mostly `- PAP-1234: title (in_progress, updated 2026-...)` is an issue list, not a wiki page. Group issues by what they are *about* (a decision, a risk, a workstream) and cite multiple issues per bullet when they share a story.
4. **Mechanical "Current as of" timestamps everywhere.** One `current_as_of` in frontmatter is enough.
5. **No interpretation.** "Active issues: PAP-A, PAP-B, PAP-C" is bookkeeping. "The team is concentrating on the schema migration ([PAP-A], [PAP-B]) and has parked the index work pending capacity ([PAP-C])." is wiki-insightful.
6. **Opaque identifiers in prose.** UUIDs, cursor ids, source hashes, run ids, and raw metadata belong in logs or frontmatter when needed, not in executive-facing project narrative.

## Workflow

1. **Read the bundle in full.** Don't sample. Read every issue title, every comment, every document key the bundle includes. Note: which issues are decisions, which are risks/blockers, which are recently completed, which are inflight.
2. **Read the existing project page** (if any) so you write a patch, not a rewrite. The "Decisions" section in particular accumulates over time — never wipe accepted decisions; supersede them with `> ⚠ reversed by ...` callouts when something later overrides them.
3. **Read the target space's `AGENTS.md`** for page conventions: filename style, YAML frontmatter shape, link style, voice. Always pass the operation issue's `wikiId` and `spaceSlug` to LLM Wiki tools.
4. **Write `wiki/projects/<slug>/standup.md` first.** Every Paperclip project represented in the wiki must have this file. It is the executive standup: where the project stands today, what changed recently, what is blocked or risky, and what happens next. Use stable sections, in this order:
   - Frontmatter (`type: project-standup`, `project: <slug>`, `current_as_of: YYYY-MM-DD`, `sources`).
   - **Executive Readout** — one short paragraph that explains the current project posture in plain language.
   - **What Changed** — the meaningful work completed or advanced since the last window. Group by concept; cite issues/comments/documents only as evidence.
   - **Decisions** — accepted/rejected/reversed decisions that changed the project direction. Omit when none exist.
   - **Blockers / Risks** — current blockers and risks with named owner or next action when the source provides one.
   - **Next Actions** — concrete next actions and owners inferred from Paperclip issues, not vague aspirations.
   - **Links** — durable wiki project page and relevant Paperclip project/issues/documents.
   Rewrite the standup to today's state. Do not append endless dated sections; the audit trail belongs in `wiki/log.md` and Paperclip comments.
5. **Write `wiki/projects/<slug>/index.md`** with these stable sections, in this order:
   - Frontmatter (`type: project`, `current_as_of: YYYY-MM-DD`, `tags`, `sources`).
   - **Overview** — 2–4 sentences saying what the project is and why it exists. Use the project description if it exists; otherwise synthesise it from the root issue.
   - **Current Direction** — narrative paragraph naming the active workstreams, the immediate next concrete deliverable, and the stance on risks. Cite 2–4 issues, do not list 20.
   - **Workstreams** — a short, grouped list. Each line is a workstream or idea, not an issue.
   - **Decisions** — accepted and reversed decisions with one paragraph each. Each decision cites the issue / approval / comment that ratified it. Format: `### Decision — short title` then a paragraph; never a bare bullet list.
   - **Open Risks / Blockers** — what could derail the project, with the issue ref that surfaces it. Skip this section when the bundle has no risk signal — do not pad with `_(none)_`.
   - **References** — readable links to the current standup and supporting Paperclip tasks/documents. Keep hashes and cursor ids out of the narrative.
6. **Optionally write `wiki/projects/<slug>/decisions.md`** when the project has accumulated more decisions than the project page can carry without becoming a wall of text. Each decision is a `## ` section with: short title, accepted/reversed/superseded status, one-paragraph rationale, citing the source. *Do not* duplicate decisions already on the project page — link instead.
7. **Optionally write `wiki/projects/<slug>/history.md`** for a compact narrative timeline of meaningful project changes. **Not** an issue dump — group by phase ("Discovery", "Architecture", "Build", "Stabilisation"), not by date. Each phase is a paragraph that cites the 2–4 issues that defined it.
8. **Refresh `wiki/index.md`** under the `## Projects` section — one line per durable project page with a one-sentence summary of the project's purpose, plus a link to the current `wiki/projects/<slug>/standup.md` when present.
9. **Append `wiki/log.md`** entry — this is where the datestamp belongs:
   ```
   ## [YYYY-MM-DD] paperclip-distill | <project name>
   - standup: wiki/projects/<slug>/standup.md
   - page: wiki/projects/<slug>/index.md
   - source hash: `<hash>`
   - cursor window: <start> → <end>
   - notes: <one line on what changed in this distill, e.g. "decisions section grew with PAP-X reversal", "low-signal window, no page changes">
   ```
10. **Surface bundle warnings** (clipped sources, low signal, stale hash). Bundle warnings → `human_review_required: true` on the patch. Do not paper over them.

## Voice

- Past-tense for completed work, present-tense for current state, future-tense only with citation ("the team plans to … per [[…]]").
- Cite Paperclip source refs inline using their issue identifier (e.g. `PAP-3179`), not opaque UUIDs.
- Use issue links as evidence, not as the shape of the page. Headings and paragraphs should be organized by concepts, workstreams, decisions, and blockers.
- Wiki voice: terse, factual, neutral. No "the team is excited to" or "this initiative aims to".
- Headings are about *content*, not metadata. `## Schema migration` not `## Active Issues`.

## When the bundle has no signal

If the bundle has no durable signal — no decisions, no risk, no completed work, only routine status churn — do **not** write a project page. Instead:

- Append a `paperclip-distill | low-signal skip` log entry naming the cursor window.
- Close the operation issue with a one-line "no durable change in this window" comment.
- Do not bump the source hash on a binding that has no proposed page.

## Verification

Before closing the operation issue:

- [ ] The project page reads as wiki content, not as a Paperclip status report. A reader new to the company should understand what the project is.
- [ ] `wiki/projects/<slug>/standup.md` exists for the represented project and reads as an executive current-state update, not a raw issue dump.
- [ ] Decisions section names decisions, not issues — every decision has a one-paragraph rationale and a citation.
- [ ] The page contains exactly one `current_as_of` (in frontmatter), zero `## [YYYY-MM-DD]` headings (those go to the log).
- [ ] Bundle warnings (clipped, low signal, stale hash) are surfaced; the patch carries `human_review_required: true` when the deployment is authenticated/public.
- [ ] `wiki/index.md` and `wiki/log.md` are updated.
- [ ] No file under `raw/` was modified.

## Tools

`wiki_search`, `wiki_read_page`, `wiki_write_page`, `wiki_list_sources`, `wiki_read_source`. Always include the operation issue's `wikiId` and `spaceSlug`. The Paperclip source bundle arrives as part of the operation context — you do not need to assemble it.
