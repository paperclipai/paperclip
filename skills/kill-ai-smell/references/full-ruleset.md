# Kill AI smell — full ruleset (verbatim vendored)

Complete rule body with Bad/Good rewrite pairs, vendored verbatim from osolmaz/tools `agents/skills/kill-ai-smell/SKILL.md` (see ../UPSTREAM.md). Load alongside ../SKILL.md before substantial prose work.

## Punctuation

**Em dashes.** At most one set per 1000 words. Restructure with commas,
parentheses, or separate sentences instead. This is the most widely known
tell, and readers now flinch at a single one.

- Bad: "The data plane — SSH, rsync, and command execution — goes
  directly to the runner."
- Good: "The data plane (SSH, rsync, and command execution) goes directly
  to the runner."

**Colon pivots.** Do not compensate for the em-dash rule with "X: Y"
constructions. Colons are for genuine lists and quoted examples. The
short punch ("The fix is simple: stop guessing.") is the obvious case,
but the longer pivot, a claim followed by a colon and its elaboration,
is the same crutch, and stamping it into paragraph after paragraph is a
tell even though each instance looks defensible alone. Human prose uses
the occasional colon; it does not hinge every paragraph on one. If more
than a couple of paragraphs in a row pivot on a colon, rewrite most of
them as two sentences or fold the elaboration in with a comma.
Semicolons should be rare.

- Bad: "The fix is simple: stop guessing."
- Good: "The fix is to stop guessing."
- Bad: "The groups overlap: the Requests README out-fragments three of
  the AI pages."
- Good: "The groups overlap. The Requests README out-fragments three of
  the AI pages."

**Semicolon chains.** Do not string an enumeration across one sentence
with semicolons. Break it into sentences, each of which says something
about its step.

- Bad: "It leases a machine; syncs your files; runs the command; streams
  output; records evidence."
- Good: "It leases a machine and syncs your files to it. The command then
  runs remotely while output streams back, and the run is recorded."

## Sentence patterns

**Contrast rhetoric.** "It is not X, it is Y", "X, not Y", "not X, but Y"
and all variants are banned. The construction forces the reader to hold a
clause (X) that the sentence immediately throws away. Say Y directly.

- Bad: "It is not a benchmark predictor. It is a roofline."
- Good: "It is a roofline."
- Bad: "This changes the packaging, not the position."
- Good: "The position stays the same."
- Bad: "Queries hit the disk, not GitHub."
- Good: "Queries hit the local database, so no GitHub quota is spent."

A plain negation is fine when the negation is the content: a genuine
non-equivalence ("fitting in memory does not imply serving usefully"), a
disambiguation between two real quantities, or a warning about a real
misconception. Use it once, plainly, without the paired "it is Y" reveal.

**"Not just X" escalation.** "It isn't just X, it's Y" and similar
intensifier patterns are banned for the same reason.

- Bad: "It's not just a linter, it's a full review pipeline."
- Good: "It runs a full review pipeline, from mapping the repo to
  validating each fix."

**Rule of three.** Lists of exactly three parallel items, sentence after
sentence, are a strong tell. In measured corpora, AI copy produces these
at several times the human rate. Vary list length, or use fewer lists.

- Bad: "It is fast, simple, and reliable. Setup takes minutes, works
  everywhere, and survives upgrades. You get speed, safety, and control."
- Good: "It is fast and needs no setup. In three months of daily use it
  has not broken once."

**Anaphora chains.** Three or more parallel negations or repetitions in a
row read as ad copy. One plain sentence saying the same thing is stronger.

- Bad: "No client ID, no redirect URI, no developer dashboard."
- Good: "You skip the developer-dashboard registration entirely."

**Fragment rhythm.** AI copy alternates verbless two-to-four word punches
with thirty-word feature enumerations. Human short sentences are full
clauses with a subject and a verb. If a paragraph swings between
fragments and freight trains, rewrite it into sentences of ordinary,
varied length.

- Bad: "Actively developed. Ships weekly."
- Good: "Development is active, with releases most weeks."

**Sentence flow.** Let main clauses run. The strongest rhythm tell in the
study corpus is that AI copy breaks nearly every sentence with a comma,
colon, dash, or parenthesis before ten words pass, while human prose
keeps producing sentences that contain one long unbroken run of words,
whatever the register. Do not chop a flowing clause into punctuated
pieces; if every sentence in a paragraph pauses by word eight, merge the
pieces back into clauses that carry through.

- Bad: "The parser, once configured, rejects unknown fields, quietly, and
  logs them."
- Good: "Once configured, the parser quietly rejects unknown fields and
  logs each one it drops."

**Hedging boilerplate.** Cut "it's worth noting that", "it's important to
remember", and similar throat-clearing.

- Bad: "It's worth noting that the cache is process-local."
- Good: "The cache is process-local."

**Overwrought transitions.** Cut "moreover", "furthermore", "in
conclusion", and summary paragraphs that restate what was just said.

- Bad: "Moreover, the parser rejects unknown fields. In conclusion,
  strict validation prevents drift."
- Good: "The parser also rejects unknown fields."

**Inflated vocabulary.** Use the plain word. "Delve", "landscape",
"testament to", "tapestry", "crucial", and "leverage" as a verb all mark
generated text.

- Bad: "It leverages a robust caching landscape."
- Good: "It uses a cache."

## Paragraph and argument shape

Sentence-level fixes are not enough. A paragraph can pass every rule
above and still read as generated, because the tell is in its shape:
generated prose argues completely and evenly, and human prose does not.

**Cut content, not just words.** Do not fill every slot of an argument.
A paragraph whose skeleton runs limitation, objection, fix, result,
caveat, confidence, with one sentence per slot and every rebuttal
pre-answered, smells no matter how good the sentences are. Merge points,
drop the weakest one, and leave an inferential step to the reader. When
a passage still smells after sentence-level fixes, the remaining fix is
deletion. A detail that already appears elsewhere in the document (a
date, a definition, a second supporting number) does not need to appear
again.

- Bad: a ten-sentence paragraph covering the limitation, the objection,
  the fix, both results, the future test, and the final confidence.
- Good: the same ground in six sentences, with the objection folded into
  the fix and one number carrying the conclusion.

**Ground abstractions in named things.** A paragraph written entirely in
the document's own coinages, with no file, person, or number in it, runs
at the concept layer where generated prose lives. Reach for the concrete
instance.

- Bad: "The structural gaps survived that control untouched."
- Good: "Triads and labeled bullets kept separating the groups after the
  READMEs went in."

**No drama vocabulary for methodology.** Findings do not "survive",
metrics do not "collapse", baselines are not "adversarial", and the next
step is not an "escalation". Say what happened in plain verbs.

- Bad: "Two metrics collapsed under the adversarial baseline."
- Good: "Two metrics stopped separating the groups once the READMEs went
  in."

**No aphorism closers.** Do not end a paragraph by promoting its
specific point into a universal principle. If the story implies the
principle, the closing slogan adds nothing; delete it.

- Bad: "That is the argument for keeping the baselines adversarial."
- Good: (nothing; the previous sentence already made the point)

**Keep the subject next to its verb.** Do not stuff a list or a chain of
qualifications between a subject and its verb. Split the sentence.

- Bad: "The sizes of the surviving gaps, three-fold at the closest edge
  and roughly twenty-fold on average with no overlap, make me
  confident."
- Good: "The closest gap is three-fold and the average is around
  twenty-fold. That margin is enough for me."

**Hold one register.** Stiff formality and bolted-on casualness in the
same passage is an uncanny mixture that neither a formal nor a casual
human writer produces. Pick the register the venue calls for and hold
it through the document.

- Bad: "I would not call this a validated classifier. A stricter test
  would need a pile of landing pages."
- Good: "I wouldn't promise these thresholds hold beyond this corpus. A
  stricter test would need human-written landing pages from after 2022."

## Openings

Say what the thing is before saying what it does. GPT-flavored copy
describes behavior and dodges identity, so the reader has to assemble
what kind of thing they are looking at. State the category in the first
sentence and the practical job in the second.

- Bad: "LocalPerf benchmarks local LLM inference servers and keeps the
  evidence in one portable run artifact."
- Good: "LocalPerf is a local LLM inference benchmark CLI. It runs
  benchmark plans against local inference servers and stores the
  evidence in one portable run artifact."

The identity sentence has degraded forms that do not count:

- The headless fragment: "A local-first GitHub triage tool for
  maintainers." Category information with no subject and no verb.
- The buried identity: opening with an imperative benefit ("Keep your
  editor and git workflow.") and stating what the tool is three screens
  down.
- Pseudo-identity: "is designed to be the layer between X and Y" states
  purpose, and "root() is the product" is a meta-remark. Neither names a
  category.

The same rule scales up: a section or report should open with sentences
that orient the reader (what this is, what was done, what follows), never
with a compressed context dump. See "Page structure" below.

## Headings

Make headings labels, not sentences. A heading names the topic of its
section as a noun phrase ("Capacity limit", "Crash testing", "Worked
examples") so the reader can scan the structure. Specific heading tells:

**Slogan headings.** A full subject-verb heading pre-empts the section
and reads as a pitch.

- Bad: "Capacity Caps the Batch"
- Good: "Capacity limit"

**Comma couplets.** The parallel two-beat slogan is among the strongest
title-level tells and appears almost exclusively in generated copy.

- Bad: "Local loop, remote box" / "Two jobs, one binary" / "Many
  providers, one loop"
- Good: "Remote execution model" / "Scope" / "Supported providers"

**Imperative slogans.** These sell the section instead of naming it.

- Bad: "Pick your path" / "Try it" / "Reuse what's warm"
- Good: "Reading guide" / "First run" / "Warm-box reuse"

**Rhetorical frames.** A run of "Why X" / "How Y" / "What you get"
headings down one outline is a smell, and so is any one template stamped
across siblings ("I want to try it / I want to wire up an agent / I want
the full reference").

- Bad: "Why spogo" / "What you get" / "Where to next"
- Good: "Design rationale" / "Feature overview" / "Further reading"

**Casing and articles.** Use sentence case. Capitalize the first word,
proper nouns, and coined terms; lowercase the rest. Keep acronyms
uppercase. Do not make "The" a reflexive prefix; drop it from noun-phrase
labels and keep it only where a full clause needs it.

- Bad: "The Memory-Fit Batch"
- Good: "Memory-fit batch"

The exception is a deliberate major statement. A heading may be a full
sentence when that sentence is a load-bearing claim the section exists to
defend, such as a named law or a thesis. Use it rarely; in a document
whose headings are otherwise noun phrases, a sentence heading should earn
its emphasis, and two in a row almost never do.

After drafting, read the headings as a flat list and check that they are
the same kind of thing: labels with labels, one register, one casing.

## Page structure

**Subtitles where intros belong.** A section that opens with compressed
context fragments has skipped the introduction. The reader gets metadata
before they know what the document is about. Write an intro in full
sentences that says what this is, what was done, and what the reader will
find, in that order. Details the reader cannot use yet belong later, next
to where they matter.

- Bad: "Six pages against three baselines. Code blocks stripped; rates
  per 1,000 words."
- Good: "This report compares six project pages against three
  human-written baselines. Before measuring, the script strips code
  blocks, and every rate is normalized per 1,000 words so the two groups
  are comparable."

**Labeled-bullet walls.** The bullet shaped "Label — one-sentence
elaboration" (or "Label. Elaboration.") is the signature layout unit of
AI landing copy; measured pages are 50 to 95 percent this one shape,
while human docs almost never use it. A run of them is a wall of parallel
fragments, and none of them explains anything. Convert runs into prose
paragraphs that connect the items, and keep bullets for genuinely
enumerable things. Vary their shape when you do use them.

- Bad: "- Zero-config discovery. Reads your editor config automatically.
  - Typed clients. Emits interfaces for every tool.
  - OAuth ergonomics. Caches and refreshes tokens."
- Good: "It discovers servers from your editor config, so there is
  nothing to set up. From that config it can emit typed interfaces for
  every tool, and it handles OAuth caching and refresh on its own."

**Formula and fact dumps.** No section may become a list of statements
one after another, whether formulas, definitions, or feature claims.
Introduce each item with prose that says why it appears, and follow
substantial items with prose that interprets them. Long derivations or
arguments must be broken into stages with the goal stated between stages.
The reader should be able to follow the conceptual path from the
surrounding paragraphs alone.

**Template stamping.** The same skeleton shipped across documents ("Why
X", "Pick your path", "Status", "Out of scope", a "five minutes"
time-to-value promise) marks a house style produced by one prompt. Any
single page looks fine; side by side they are unmistakable. Let each
document's structure follow its content.

**Word diarrhea.** Do not pad with exhaustive feature taxonomies,
implementation internals, long option catalogs, or process history the
reader does not need for the task at hand. Being comprehensive about the
wrong things is a tell of its own.

**Emoji feature grids.** The grid of emoji-headed feature cards is the
most recognizable generated landing-page layout. Do not use emojis as
section markers or bullets at all.

**Manual heading numbers.** Do not number Markdown headings by hand. Let
the renderer or publication system number sections when numbering is
needed.

- Bad: "## 1. Overview"
- Good: "## Overview"

## Repetition and word choice

Generated text avoids repeating itself: each mention of a thing gets a
fresh synonym, which pushes lexical variety above the human range. Human
writers repeat deliberately. They reuse the established term for a
concept instead of rotating synonyms, and they repeat a phrase for
emphasis when hammering a point. Keep one name per concept through a
document, and let purposeful repetition stand.

- Bad: "The tool syncs issues locally. The utility then clusters them,
  and the binary ships a TUI for browsing."
- Good: "The tool syncs issues locally, clusters them, and ships a TUI
  for browsing them."

The same applies to sentence shape in reverse: humans vary rhythm
naturally, while generated text stamps one shape (or one bullet template)
many times. Uniform novelty in words plus uniform sameness in structure
is the combination to break up.

## Final sweep

Before finishing any writing task, check the draft against this list:

- Em dashes within budget; no "X: Y" punch lines; no semicolon chains.
- No contrast rhetoric or "not just X" anywhere.
- No run of exactly-three lists; no anaphora chains.
- No verbless fragments doing a sentence's job.
- No paragraph that fills every argumentative slot; something was cut.
- Every paragraph contains at least one named thing (a file, a person,
  a number), and no drama verbs narrate the methodology.
- No aphorism closing a paragraph; no list wedged between a subject and
  its verb; one register throughout.
- The document says what its subject is before what it does.
- Sections open with orienting sentences, never context-dump fragments.
- Headings are sentence-case noun-phrase labels; no slogans, comma
  couplets, imperatives, or repeated rhetorical frames.
- No labeled-bullet walls; bullets vary in shape and are genuinely lists.
- No hedging, inflated vocabulary, or restating summaries.
- One name per concept; repetition only where it serves emphasis.

When editing existing text, fix a smell by restructuring the sentence or
the section. Swapping one banned pattern for another (an em dash for a
punchy colon, a triad for an anaphora chain) changes nothing.

## Mechanical check

This skill ships `check.py`, a stdlib-only script that runs the
measurable subset of the rules above. Rewrites reintroduce the patterns,
so run it on the draft after every revision:

```
python3 check.py draft.md
```

It prints findings with line numbers at two severities and exits nonzero
when any violation remains:

- A `VIOLATION` is a banned pattern or a rate over budget: em dashes
  beyond one per thousand words, semicolon chains, "not just X",
  hedging phrases, anaphora chains, exactly-three lists past the
  detector threshold, labeled bullets past 30% of all bullets, and
  manually numbered headings. Fix all of these by restructuring, then
  rerun until the file is clean.
- A `REVIEW` needs judgment. "X, not Y" is allowed when the negation is
  the content; a colon before a list is fine; a heading with a comma may
  be a legitimate title. Read each flagged line and decide; do not
  mechanically rewrite them.

Two document-level `REVIEW` stats come from the stylometric study rather
than from a single line. Sentence flow reports when the mean longest
unbroken run of words per sentence falls under 10, which in the study
corpus happens to every AI page and no human text; the fix is to let
main clauses run instead of chopping them with punctuation. MTLD
lexical diversity reports when synonym rotation pushes the score past
110, where every AI page in the corpus sits; the fix is to reuse the
established word for a thing.

The script cannot see paragraph shape, register, or aphorism closers,
so a clean run does not replace the checklist above. Human baselines in
the study corpus average under one violation per document while the AI
pages average more than three. A draft that reports several violations
needs restructured sections rather than patched sentences.

## Where the rules come from

Every threshold in this skill was measured, not asserted. The rules
derive from a stylometric study of ten AI-written landing pages
against eight provably pre-LLM human texts, plus 42 in-the-wild tweet
samples, maintained in the
[ai-smell repository](https://github.com/osolmaz/ai-smell) and written
up at [solmaz.io/ai-de-smeller](https://solmaz.io/ai-de-smeller). For
the per-rule evidence, including which tells separate the corpus with
no overlap, which are one-directional, which collapsed into register
signals, and how to test a new tell candidate, see
[evidence.md](evidence.md) in this skill's folder.
