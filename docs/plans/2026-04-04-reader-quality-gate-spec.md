# Reader Quality Gate Spec

## Goal

Raise Fluxaivory article quality by tightening publish-ready gates instead of increasing article volume.

The core rule is:

- a good article is not the article with the most information
- a good article is the one the reader can understand quickly and remember clearly

## Five Quality Dimensions

Every publish-ready article should be strong on all five dimensions:

1. `lead`
2. `structure`
3. `explainer clarity`
4. `concrete example / felt scene`
5. `editing density`

These dimensions should be enforced through preflight gates before final editorial approval.

## Lead Requirements

The opening should answer, within the first screen:

- what happened
- why it matters
- why the reader should care

Failure patterns:

- headline repetition
- abstract setup without reader meaning
- technical framing before reader relevance

Minimum rule:

- the first 3 to 5 sentences must contain change + significance + reader meaning

## Structure Requirements

Fluxaivory should default to explainer structure, not straight news recap.

Preferred flow:

1. what happened
2. why it matters
3. who feels it first
4. what is overstated or uncertain
5. what the reader should watch or do next

Failure patterns:

- fact pile without meaning
- title promise not surfaced early
- ending without judgment or decision payoff

## Explainer Clarity Requirements

Technical or niche language must be explained on first mention.

Acceptable explainer bridges:

- `쉽게 말하면`
- `한마디로`
- `풀어 말하면`
- `일반 사용자 기준에서는`
- equivalent plain-language explanation in English

Failure patterns:

- term introduced without explanation
- jargon cluster on first screen
- concept definition that only restates the jargon

## Concrete Example Requirements

Important concepts should be grounded in at least one practical usage scene.

Acceptable scene markers:

- `예를 들어`
- `가령`
- `대표적으로`
- `실제로는`
- equivalent concrete example phrases in English

Rule:

- the article should contain at least 1 concrete example
- deeper or more abstract articles should contain 2 or more

Failure pattern:

- explanation remains abstract and never becomes imaginable

## Editing Density Requirements

Reader-perceived quality depends on editing density, not only sentence quality.

Preferred surfaces:

- quick-scan block
- comparison table or comparison block
- checklist or next-steps block
- supporting visual
- TOC for long or dense articles

Minimum rule:

- at least one quick summary surface
- at least one table or comparison block for dense comparison content
- at least one checklist or next-step block
- TOC when the article is long enough to require orientation

## Reader Question Rule

Each major section should answer a reader question.

This should not be enforced paragraph-by-paragraph, but section-by-section.

Failure pattern:

- sections that restate background without advancing reader understanding

## Deletion Rule

Quality should improve by removing low-value sentences, not only by adding more text.

Delete aggressively when a sentence is:

- repeating the headline
- generic background with no decision value
- restating earlier content
- adding hype without evidence

## Hard Gate Recommendations

The following should block publish-ready:

- weak lead
- missing first-mention explanation for technical terms
- no concrete example
- missing quick-scan / comparison / checklist surfaces where needed
- missing ending judgment
- title-body-ending misalignment
- topic/source misalignment

## Owner Mapping

- `Research Lead`: factual alignment and source grounding
- `Explainer Editor`: lead, term explanation, plain-language clarity
- `Reader Experience Editor`: scan path, drop-off risk, ending payoff, editing density
- `Visual Editor`: quick-scan, tables, support visuals, TOC clarity
- `Editor-in-Chief`: final publish-ready editorial judgment

## Immediate Implementation Targets

1. strengthen `explainer_precheck.py`
2. strengthen `reader_experience_precheck.py`
3. keep `topic_alignment_precheck.py` as the title/body/ending contract backstop
4. preserve `visual_preflight.py` as the editing-density visual gate
