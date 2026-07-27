---
name: kill-ai-smell
description: Remove AI writing tells from prose, headings, openings, and page structure. Use when writing or editing docs, READMEs, PR/issue text, blog posts, site copy, reports, or emails, or when the user mentions AI smell, AI tells, slop, or em dashes.
---

# Kill AI smell

AI-written text has recognizable tells, and readers who spot them discount
the whole document. The tells run deeper than word choice. They show up in
punctuation, in sentence shape, in how a document opens, in what headings
look like, and in the layout of a page. This skill covers each level in
turn, from the smallest unit to the whole document. Apply the rules to
everything you write or edit, and sweep for violations before finishing
any writing task.

One principle governs all of it: write for a reader who is following a
thought from beginning to end. Slop mentions things; writing explains
them. When a passage lists facts without saying why the reader should
care, or compresses context into fragments the reader must decode, the
fix is to rewrite it as sentences that carry the reader forward. Every
rule below is a special case of this.

Knowing these rules is no defense against violating them. The patterns
are how models write by default, so they appear even in text about the
patterns, including rewrites produced to fix an earlier sweep. Sweep
your own output mechanically after every revision; do not trust your
ear, and do not let a violation stand because you can articulate a
stylistic justification for it after the fact.

Full ruleset with the Bad/Good rewrite pairs: `references/full-ruleset.md`.
Read it before any substantial prose task (docs, READMEs, posts, reports,
site copy). The index below names every rule and its measured budget; the
rewrite shapes live in the reference. The fix is always restructuring,
never swapping the banned pattern for a neighboring one.

## Rule index

Punctuation
- Em dashes: at most one set per 1000 words. Restructure with commas, parentheses, or separate sentences.
- Colon pivots: no "X: Y" punch lines; colons only for genuine lists and quotes. Three consecutive paragraphs hinging on a colon is a violation.
- Semicolon chains: never two or more semicolons in one sentence; keep semicolons under 3 per 1k words.

Sentence patterns
- Contrast rhetoric banned: "it is not X, it is Y" and variants. Plain "X, not Y" only when the negation is the content.
- "Not just/only/merely X" escalation banned.
- Rule of three: exactly-three lists must stay under 3 per 1k words; vary list length.
- Anaphora chains banned ("no X, no Y, no Z").
- Fragment rhythm: no verbless two-to-four-word punches; fragments must stay under 15% of sentences.
- Sentence flow: mean longest unbroken word run per sentence must reach 10 or more (AI copy sits at 4.9-8.8). Let main clauses run without punctuation breaks.
- Hedging boilerplate banned ("it's worth noting", "keep in mind that", ...).
- Overwrought transitions banned (moreover, furthermore, in conclusion, in summary).
- Inflated vocabulary: use the plain word; delve, landscape, tapestry, testament to, crucial, leverage, robust, seamless all flag.

Paragraph and argument shape
- Cut content, not just words: do not fill every argumentative slot; delete details that already appear elsewhere.
- Ground abstractions in named things: every paragraph carries a file, a person, or a number.
- No drama vocabulary for methodology (survive, collapse, adversarial, escalation).
- No aphorism closers promoting the point into a universal principle.
- Keep the subject next to its verb; split the sentence instead of stuffing qualifications between them.
- Hold one register through the document.

Openings
- Say what the thing is (its category) before what it does. No headless fragments, buried identity, or pseudo-identity openings.

Headings
- Sentence-case noun-phrase labels. No slogan headings, comma couplets ("Local loop, remote box"), imperative slogans, rhetorical frames ("Why X"), Title Case, or manual heading numbers.

Page structure
- Sections open with orienting sentences, never compressed context-dump fragments.
- Labeled bullets ("Label - one-sentence elaboration") must stay under 30% of all bullets; convert runs into connected prose.
- No formula/fact dumps, template stamping across documents, padding taxonomies, or emoji feature grids.

Repetition and word choice
- One name per concept; reuse the established term instead of rotating synonyms. MTLD lexical diversity over 110 flags synonym rotation.
- Purposeful repetition for emphasis stands.

## Workflow

1. Read `references/full-ruleset.md`, then draft with the budgets above in view.
2. Run `python3 check.py draft.md` after every revision; rewrites reintroduce the patterns.
3. A `VIOLATION` is a banned pattern or a rate over budget: restructure and rerun until the file is clean (exit 0). A `REVIEW` needs judgment: read the flagged line and decide; do not mechanically rewrite it.
4. The script cannot see paragraph shape, register, or aphorism closers, so a clean run does not replace the Final sweep checklist in the full ruleset.

## Where the rules come from

Every threshold was measured against a stylometric corpus, not asserted; per-rule evidence is in [evidence.md](evidence.md) and the [ai-smell repository](https://github.com/osolmaz/ai-smell).
