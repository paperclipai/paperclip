---
name: storm-research-brief
description: Use for high-value research or decision questions that need evidence, multiple perspectives, contradiction mapping, synthesis, and red-team review before producing a concise decision brief.
key: paperclipai/optional/research/storm-research-brief
defaultInstall: false
recommendedForRoles:
  - researcher
  - cto
  - product
tags:
  - research
  - synthesis
  - storm
  - decision-brief
  - evidence
version: 1.0.0
author: Alt / Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [research, synthesis, storm, decision-brief, multi-agent, evidence]
    related_skills: [research-intelligence-workflows]
---

# STORM Research Brief

## Purpose

Use this skill when a question deserves more than a single-pass answer: strategy, product decisions, market research, technical bets, controversial claims, investment-style judgment, learning a difficult topic, or preparing a memo/presentation.

This is inspired by Stanford STORM's core pattern: research through multi-perspective questioning and synthesis. Do **not** treat it as magic prompting. The useful part is the workflow: evidence first, perspectives second, contradiction mapping third, synthesis last.

## When to Use

Use for:

- “Can we learn something here?” on a substantive article/thread/paper.
- “Should we do X?” decisions where evidence matters.
- “Research X and give me a brief.”
- “What’s the best argument for/against X?”
- “Explain this space / opportunity / risk.”
- Any broad topic where one generic answer would collapse nuance.

Skip for:

- Simple factual lookups.
- Small implementation questions.
- Cases where the user only wants a quick take.
- Tasks where no external/current evidence is needed and the answer is obvious.

## Role Split

- **Alt / main profile:** frames the question, decides whether the method is worth the overhead, selects lenses, synthesizes into action.
- **Researcher profile:** executes bounded research packets with sources, confidence, gaps, and reviewer instructions.
- **Subagents:** optional isolated perspectives or evidence passes. They are not automatically the `researcher` profile.
- **Reviewer profile:** optional verification/red-team pass for important outputs.

For quick work, run the skill directly. For durable/high-stakes work, route: Alt → researcher → reviewer → Alt.

## Workflow

### 1. Frame the research question

Write a tight task packet before researching:

- Question / decision to support.
- Scope and non-goals.
- Audience and artifact format.
- Time sensitivity.
- Required evidence standard.
- What would change the answer.

If the user is vague but intent is obvious, make a reasonable assumption and state it briefly.

### 2. Evidence pass first

Gather evidence before generating perspectives.

Source order:

1. Local/project/GBrain/internal context when the answer should already exist locally.
2. Primary sources: docs, papers, filings, official pages, repositories, transcripts, datasets.
3. Credible secondary sources: high-quality analysis, expert commentary, reputable media.
4. Social/community discussion only as weak signal unless the question is about sentiment or discourse.

Capture:

- URL/file/path/message reference.
- Date or version when relevant.
- Key claim supported by each source.
- Confidence / reliability note.

Do not fabricate citations. Do not let the model “remember” current facts without checking.

### 3. Choose lenses

Pick 3–5 lenses that actually create useful tension. Common defaults:

- **Operator / builder:** what changes execution?
- **Customer / user:** what pain, behavior, adoption, or trust issue matters?
- **Technical / implementation:** feasibility, constraints, hidden complexity.
- **Market / economic:** incentives, distribution, business model, competitive pressure.
- **Skeptic / failure-mode:** why this might be wrong, overhyped, unsafe, or not worth doing.

Optional lenses when relevant:

- Academic / scientific validity.
- Legal / regulatory / compliance.
- Security / abuse.
- Historical analogy.
- Investor / capital allocation.
- Organizational / process.

### 4. Perspective passes

For each lens, produce:

- Strongest claim from that viewpoint.
- Evidence supporting it.
- Main risk or objection.
- What this lens would recommend doing.
- Confidence level.

If using subagents, give each subagent one lens and require sources plus uncertainty. Do not ask them to solve the whole problem.

### 5. Contradiction map

Before synthesis, explicitly map:

- Where lenses agree.
- Where they disagree.
- Which disagreements are evidence-based vs value/priority tradeoffs.
- Missing evidence.
- Assumptions that drive the answer.
- What would make the conclusion flip.

This is the highest-value section. Do not skip it.

### 6. Synthesis

Produce a decision-oriented brief, not an encyclopedia.

Default structure:

```markdown
# Brief: <topic>

## Bottom line
<1–3 sentences>

## What matters
- <most important finding>
- <second finding>
- <third finding>

## Evidence
| Claim | Support | Reliability |
|---|---|---|
| ... | ... | ... |

## Perspective map
| Lens | What it sees | Recommendation | Confidence |
|---|---|---|---|
| Operator | ... | ... | ... |

## Contradictions / tensions
- <tension + why it matters>

## Judgment call
<clear recommendation or decision framing>

## Next actions
1. <smallest useful action>
2. <verification / experiment>
3. <owner or follow-up if relevant>

## Gaps
- <unknowns / missing evidence>
```

For Discord/chat, compress the structure: bottom line, useful lessons, risks, next action.

### 7. Red-team pass

Before finalizing, attack the brief:

- Which claim is weakest?
- Which source is least reliable?
- Did we confuse popularity with truth?
- Did we overfit to a viral framing?
- Are there missing stakeholders or incentives?
- Are we recommending motion without enough evidence?
- Could the conclusion be simpler: “interesting, but not actionable”?

Revise the final answer if the critique finds real weakness.

## Multi-Agent Pattern

Use only when the question is worth the overhead.

### Small task

Alt runs the whole workflow directly.

### Medium task

Alt delegates 2–3 bounded subagent tasks:

- Evidence collector.
- Skeptic/failure-mode lens.
- Operator/action lens.

Alt synthesizes and verifies important claims.

### Large/durable task

Use profile/Kanban routing:

1. Alt creates bounded research packet.
2. `researcher` profile runs evidence + STORM synthesis.
3. `reviewer` profile checks sources, gaps, and overclaims.
4. Alt turns output into decision/action.

If spawning the actual researcher profile manually, use `hermes -p researcher ...`; `delegate_task` alone does not automatically use that profile.

## Local Repo / PRD Architecture Briefs

When the brief is about an existing local repo or data product, load local evidence before external research. Read the PRD/narrative note, inspect the repo docs/code/tests/dashboard/data shape, respect repo guardrails, then use external sources only to evaluate stack tradeoffs. See `references/local-repo-architecture-briefs.md` for the detailed pattern.

## Quality Bar

Good output:

- Evidence-backed.
- Short enough to act on.
- Explicit about uncertainty.
- Shows disagreements, not just consensus.
- Ends with a next action or a conscious no-action recommendation.

Bad output:

- Generic “pros/cons.”
- Persona cosplay without sources.
- Long background dump.
- Fake certainty.
- Viral-thread summary with no transfer to William’s work.
- “More research needed” without saying what research and why.

## Verification Checklist

Before final answer:

- [ ] Did we gather evidence before synthesis?
- [ ] Are citations/paths/URLs real and relevant?
- [ ] Did we separate facts from judgment?
- [ ] Did we include contradictory perspectives?
- [ ] Did we state confidence and gaps?
- [ ] Did we produce an actionable next step or clear no-action call?
