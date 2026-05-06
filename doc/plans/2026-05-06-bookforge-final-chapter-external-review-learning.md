# Bookforge final-chapter external review learning

Date: 2026-05-06
Company: Bookforge Lab
Related Bookforge project: `the_last_safe_lie`
Related live Bookforge queue item: Chapter 14 whole-book/manual-review quality hold

## Lesson to add to Paperclip Bookforge Lab

When a final chapter receives an external review that says it is overlong, repetitive, or leaning on a repeated final-line slogan, Paperclip must treat that as a surgical editorial repair workflow, not a broad rewrite and not a reason to resume Bookforge generation.

## Required safe workflow

1. Check live Bookforge state first.
   - Verify worker, queue, current item, and spending.
   - If Bookforge is running/spending, stop only through the approved safety path.
   - Do not clear a quality hold during the prose repair.

2. Back up first.
   - Back up the promoted chapter being edited.
   - Back up any earlier promoted chapters touched by repeated-phrase cleanup.
   - Back up `manuscript.md`, `queue_state.json`, and project `phase_state.json` when relevant.

3. Tighten surgically.
   - Preserve the book’s ending shape and evidence/custody logic.
   - Cut repeated explanation, duplicated scene beats, and abstract thesis sentences.
   - Prefer 15–20% tightening for a final chapter that is usable but too long.
   - Do not perform a broad rewrite unless the chapter structure is truly broken.

4. Remove repeated slogans across promoted chapters.
   - Search promoted `chapter_??.md` files, not draft/archive files.
   - If the same chapter-ending line or slogan appears repeatedly, replace it with chapter-specific physical images, choices, threats, or object movements.
   - Do not fix only the final chapter if the complaint is whole-book repetition.

5. Reassemble the manuscript offline.
   - Rebuild `manuscript.md` from promoted chapters.
   - Confirm chapter count and missing-chapter list.

6. Verify without spending tokens.
   - Search for the retired phrase/name/over-explained phrase.
   - Confirm final chapter word-count delta.
   - Run local deterministic style/anti-AI checks where available.
   - Re-check live Bookforge/Paperclip state before reporting.

7. Preserve gates.
   - Do not clear unrelated Bookforge quality holds.
   - Do not resume Bookforge generation without explicit approval.
   - Do not wake Paperclip agents or create assignment-trigger loops just to record the lesson.

## Example evidence from The Last Safe Lie, Chapter 14

The external review named these issues:
- Chapter 14 too long/repetitive.
- The DNR outpost repeated earlier reluctant-ally/terminal/alarm/printout/escape beats.
- The bait/hidden-proof/real-proof concept was repeated too often.
- The final culvert scene dragged.
- The final line `The next move must happen before the trace, audit, or pursuer catches up.` was overused.
- DNR supervisor `Aris` confused with Medical Board Aris.
- Cassette recorder origin was over-explained.
- Corinne boot/hidden-proof beat repeated.
- Elias’s left shoulder/arm injury needed a visible reminder.

Safe repair performed:
- Backed up promoted chapter/state first.
- Cut Chapter 14 from about 3,362 words to about 2,730 words, about 18.8%.
- Renamed the DNR supervisor from `Aris` to `Graham`.
- Compressed the cassette recorder origin.
- Reduced repeated custody/proof explanations.
- Added visible reminders that Elias’s left arm is injured and he uses his right hand.
- Removed the repeated final-line slogan from promoted Chapters 2, 3, 8, 10, 11, 13, and 14.
- Reassembled manuscript: 14 chapters, no missing chapters.
- Left the unrelated Bookforge quality hold in place.
- Did not resume generation.

## Future prevention rule

Paperclip Scribe / Continuity Auditor / Inspector / Publisher workflows should recognize final-chapter external reviews as checklist-driven surgical repair tasks:

`review note -> verify in promoted text -> backup -> surgical edit -> whole-book repeated phrase search -> reassemble -> local no-token checks -> leave unrelated holds untouched -> Steward approval before any resume`

This belongs in the Bookforge Lab learning ledger/model-scorecard operating layer and should be linked to any future issue about final-chapter editorial repair, repeated chapter-ending slogans, or post-book external review tightening.
