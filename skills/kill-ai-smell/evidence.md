# Evidence behind the kill-ai-smell rules

This file carries the measurements that justify the rules in SKILL.md,
so the rules can stay short. Read it when you need to know how strong a
rule is, when someone challenges a rule, or when you want to extend the
study. Everything here is reproducible from the
[ai-smell repository](https://github.com/osolmaz/ai-smell), and the
write-up is the blog post
[Building an AI de-smeller](https://solmaz.io/ai-de-smeller).

## The corpus

The ground truth is 18 documents. The AI side is ten OpenClaw project
landing pages written by GPT 5.5 (4,853 words after stripping code).
The human side is eight texts frozen before language models existed
(15,317 words): the SQLite testing docs, essays by Spolsky (2000),
antirez (2018), Graham (2009), and Evans (2019), and the ripgrep,
Redis, and Requests READMEs at 2016-2017 git tags. The READMEs matter
because they sell tools the way landing pages do, which controls for
register. Two register-sensitive metrics (first person, type-token
ratio) looked like tells against essays alone and collapsed once the
READMEs entered the corpus. Treat any new tell with suspicion until it
survives a register-matched baseline.

There are also 42 long-form tweet samples with no ground truth, used
only to see how the thresholds transfer to the feed, and the blog post
itself, archived as a known-AI, skill-compliant control.

All rates are per 1,000 words. One AI model, one register, 18
documents: these are demonstrations with wide margins, not a validated
classifier.

## Strength of each rule

Ranked by the evidence, strongest first.

**Exactly-three lists (triads).** AI 6.3-15.9 per 1k, human 0.0-2.0.
No overlap. Every AI page is at least 3x every human text, and the
corpus averages differ about 19x. One of the two detector rules (threshold 3
per 1k). This is the strongest punctuation-level tell.

**Labeled bullets.** Share of bullets that open with a short label,
then a separator, then elaboration: AI 53-100%, human 0-11%, and five
of eight human texts never use the shape. The other detector rule
(threshold 30%). More diagnostic than any punctuation rate.

**Sentence flow.** Longest unbroken run of words per sentence, ranked
against a pooled corpus and averaged (the Mann-Whitney statistic of
the document's runs against the pool): AI 0.19-0.41, human 0.49-0.73,
no overlap, leave-one-out 18/18. In raw words, AI pages average a
4.9-8.8-word longest run, human texts 10.0-18.3. Found by an
autoresearch-style search (about fifty logged experiments, preserved
in the repo's `autoresearch/` directory). The negative result matters:
every order-only statistic (alternation, turning points,
autocorrelation, permutation-normalized jaggedness) failed to
separate the groups, so the tell is the level of the runs, never the
order they come in.

**Word choice, measured properly.** MTLD lexical diversity: all ten AI
pages above 111, seven of eight human texts under 106. Mean Zipf word
frequency: every AI page 5.30 or below, every human text 5.28 or
above. Each axis has one crossover (Requests on diversity, ripgrep on
frequency) but no document fails both, so the pair classifies the
corpus. The mechanism is connective tissue rather than fancy words:
human text is nearly half made of the commonest English words because
full sentences run on articles and prepositions, while telegraphic
noun piles need none. Raw type-token ratio does not work, because it is a
register signal (the punchy Requests README scores AI-high).

**Em dashes.** Corpus averages differ about 18x, and the heaviest AI
page lands one every 16 words. But the tell is one-directional: three
of ten AI pages use fewer em dashes than the 2016 ripgrep README and
one uses none. Bulk convicts, and absence proves nothing. That is why the
skill budgets em dashes but the detector dropped them.

**Heading register.** About a third of AI headings are slogans,
imperatives, or rhetorical frames versus one in ten for humans (mostly
mild FAQ questions). The comma couplet ("Two jobs, one binary")
appeared 11 times across five of ten AI sites and once in the human
set, as a deliberate essay title. Title Case turned out to be a human
convention of an era, so the skill flags rhetoric rather than casing.

**Identity deferral.** All three pre-LLM READMEs state what the tool
is in their opening lines, and one of ten AI pages does. The raw
action-to-identity predicate ratio does not separate groups (all body
prose is verb-led); the position of the identity claim does.

**Fragments.** AI pages run 3.6-41.9% verbless sentences of four words
or fewer, humans 1.4-17.4%. The ranges overlap (Requests out-fragments
three AI pages), so fragments corroborate rather than convict.

**Template phrasing across documents.** "Pick your path" on six of ten
AI sites, a "five minutes" promise on seven, "Status" on eight, the
exact closer "Released under the MIT license." on six. Only visible
across a set, since each page looks fine alone. No per-document threshold.

**First person.** Dead as a tell. Essays are saturated with it, but
the pre-LLM READMEs have almost none, exactly like the AI pages. It
tracks register, kept in the skill only as a reminder that some
signals are register.

## Tells that fire on their own author

The study's most instructive event: the agent that had just measured
contrast rhetoric as a top tell titled its own report callout "The
strongest tells are structural, not lexical". Knowing the rules is no
defense, because the patterns are the model's defaults. This is why
the skill demands a mechanical sweep of your own output, and why
`check.py` exists. The blog post that documents the study is archived
in the corpus as `corpus/self/` and clears every detector, which shows
the tells are defaults rather than fingerprints, and an instructed
model stops producing them.

## Interpreting check.py numbers

Human baselines average under one violation per document, and the AI
pages average more than three. A draft with several violations needs
restructured sections, not patched sentences, because patching swaps
one pattern for another (the em dash becomes a punchy colon, the triad
becomes an anaphora chain) and the rates stay high. The document-level
stats have known clean ranges: mean longest run of 10+ words and MTLD
under 110 put a draft with the human baselines on both axes.

## Extending the study

New tell candidates should be tested against the archived corpus, not
against intuition. Clone the ai-smell repository, add a counter to
`analyze.py` or a scorer in the style of `analyze_flow.py`, and demand
separation against the register-matched baselines before believing it.
For open-ended searches, the repo's `autoresearch/` directory shows
the loop that found the flow metric (frozen harness, one editable
feature file, a journal of every run); the same method is available as
the `autoresearch-loop` skill.
