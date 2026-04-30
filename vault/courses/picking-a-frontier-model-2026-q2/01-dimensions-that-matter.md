---
course_slug: picking-a-frontier-model-2026-q2
chapter_num: 1
chapter_slug: dimensions-that-matter
title: "How to choose frontier model evaluation dimensions for production workloads"
status: awaiting-g0
author: editorial-team
agent_drafted_by: ca965eff-ea59-4030-91de-47845d3600c6
vendor_tag: koenig-ai-academy
content_type: course-chapter
date: 2026-04-30
duration_min: 40
prerequisites_chapters: []
learning_objectives:
  - "Identify the 5 evaluation dimensions that consistently separate frontier models on real production workloads"
  - "Name 3 commonly cited benchmarks that correlate poorly with production outcomes and explain the gap"
  - "Build a custom scorecard template scoped to a specific use case"
  - "Distinguish 'frontier model' from 'best model for your use case'"
key_concepts:
  - evaluation dimensions
  - benchmark proxy gap
  - tool-use determinism
  - context fidelity
  - use-case-first selection
  - capability overhang
hands_on_exercise: "Build a weighted scorecard for your use case and defend your top-2 dimension priorities"
sources:
  - https://docs.anthropic.com/en/docs/about-claude/models/overview
  - https://openai.com/index/introducing-gpt-5-5/
  - https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-pro
  - https://ai.google.dev/gemini-api/docs/changelog
  - https://gorilla.cs.berkeley.edu/leaderboard.html
  - /data/claude-tool-use-determinism/2026-Q2/
  - https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  - https://openai.com/index/api-prompt-caching/
  - https://ai.google.dev/gemini-api/docs/caching
tags:
  - course/picking-a-frontier-model-2026-q2
  - evaluation
  - frontier-models
  - benchmarking
---

# How to choose frontier model evaluation dimensions for production workloads

> **Prerequisites**: None — this is the entry point for the course.
>
> **Time**: 40 minutes
>
> **Learning objectives**: By the end of this chapter, you can name the 5 evaluation dimensions that reliably predict production success, identify 3 popular benchmarks that don't, and fill in a scorecard for your specific use case.

Frontier model evaluation is the practice of measuring AI model capabilities along structured axes to predict production performance, rather than performance on standardized academic tests. As of Q2 2026, three models dominate serious production AI workloads: Claude Opus 4.7, GPT-5.5, and Gemini 3.1 Pro. This chapter gives you the conceptual scaffolding to decide *which* benchmark dimensions you actually need to measure for your workload before you run a single API call.

## Key facts

1. **MMLU**, **HumanEval**, and **GPQA** — the three benchmarks most commonly cited in model release notes — measure knowledge recall, single-function code generation, and graduate-level science respectively. None directly measures tool-use consistency, structured-output stability, or mid-context retrieval accuracy. [1][2]
2. As of Q2 2026, no major public benchmark measures **tool-use determinism** — the probability that the same prompt produces structurally equivalent output across independent runs. Our internal dataset (`/data/claude-tool-use-determinism/2026-Q2/`) fills this gap for the three models covered in this course.
3. Opus 4.7's published context window is **1M tokens** [7]; Gemini 3.1 Pro's is **1M tokens** [8]. Empirically measured retrieval accuracy at 80% of each model's advertised limit tells a different story — covered in [[courses/picking-a-frontier-model-2026-q2/03-long-context-behavior|Chapter 3]].
4. **Prompt caching** is available on all three platforms but with meaningfully different economics: Anthropic caches at 4,096+ token boundaries for current flagship models (e.g., Claude Opus 4.7; the minimum drops to 1,024 tokens for older models such as Sonnet 4.5 and Opus 4.1) with a 5-minute TTL [9], OpenAI caches at 1,024+ token boundaries in 128-token cache-hit increments [10], and Google Cloud caches Gemini context at configurable TTL (default: 1 hour) [11]. The cost implications for agentic workloads are non-trivial — [[courses/picking-a-frontier-model-2026-q2/04-cost-per-task|Chapter 4]] quantifies them.
5. The term **"capability overhang"** refers to the gap between what a model can do in a best-case scenario and what it does reliably across the distribution of real inputs. Frontier models exhibit significant capability overhang on production workloads. A model that scores 95% on a coding benchmark may succeed on only 70% of your specific code-generation prompts.
6. In our 10×3×5 benchmark (10 prompts × 3 models × 5 runs), the variance in output *structure* at temperature=0 ranged from **2% to 18%** across the three models — variance that leaderboard scores do not capture and that compounds multiplicatively in multi-step pipelines. [3]
7. The **"production gap"** — the documented delta between academic benchmark performance and real-task performance — is most pronounced in function-calling tasks, where benchmark scores and real-world tool-orchestration reliability can diverge substantially. Aggregate benchmarks such as MMLU do not measure multi-step tool use; the Berkeley Function Calling Leaderboard (BFCL) is the most widely-cited public evaluation for this dimension, tracking real-world function-calling accuracy across leading models. [4]

---

## Why the standard benchmarks fail builders

Every model release in 2026 ships with a table comparing MMLU, HumanEval, GPQA, and MATH scores. These benchmarks are not fraudulent — they measure real things. But they measure things that matter for *research progress*, not for *shipping a reliable product*.

Consider MMLU (Massive Multitask Language Understanding). It evaluates knowledge recall across 57 academic subjects via multiple-choice questions. A model that achieves 92% on MMLU has broad factual recall. But your coding agent, document summarizer, or customer-support bot does not answer multiple-choice questions about high-school biology. It calls tools with structured JSON schemas, retrieves facts from documents you provide, and produces outputs that downstream code must parse. None of those capabilities are measured by MMLU. [1]

HumanEval is more practically relevant — it measures code generation on isolated function-completion tasks. But it measures *single-function correctness*, not the kind of multi-step, tool-integrated code generation that represents the real workload of a coding agent. A model can score 90% on HumanEval and still routinely produce subtly malformed JSON schemas that break your function-calling pipeline. The benchmark is not wrong; it is just not measuring your problem. [5]

The third major benchmark, GPQA Diamond (Graduate-Level Google-Proof Q&A), measures PhD-level reasoning in science. It is an excellent proxy for raw reasoning depth. It is a poor proxy for whether a model will reliably return a consistently structured response to the same tool-call prompt across five independent runs.

This is not a criticism of the research community. These benchmarks serve their purpose: driving reproducible comparisons between models on controlled tasks. The problem is that builders use them as a proxy for production fitness, and the correlation is weaker than it appears.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I'm evaluating you for a production customer-support bot. On a scale of 1-10, how would you rate yourself on: (1) tool-use determinism — returning the same JSON schema structure across repeated calls with the same prompt, (2) mid-context retrieval accuracy — correctly referencing facts from documents provided in the middle of a 100K-token context, (3) latency p95 — your 95th percentile response time for a 500-word output. Be honest about your limitations."
  expectedOutput="The model will give a candid self-assessment with some caveats. Notice: it cannot give you actual p95 latency figures (it has no access to runtime metrics), and its self-assessment of determinism will be approximate rather than empirically grounded. This illustrates why self-reported benchmarks — whether from the model or from the vendor — are not a substitute for measurement."
/>

The exercise above illustrates a key insight: **the model cannot tell you its own production reliability.** The vendor's benchmark table cannot either. The only thing that tells you production reliability is running the model on *your prompts* and measuring the outputs. That is what Chapters 2–4 of this course are built around.

---

## The 5 dimensions that predict production success

Based on our internal benchmark data across 12 months of production AI workloads, these are the five dimensions that consistently separate models in ways that matter:

### 1. Tool-use determinism

The probability that the same prompt, at the same temperature, produces structurally equivalent tool calls or JSON output across independent runs. For agentic pipelines where model output feeds into downstream code, a 10% variance in output structure compounds dramatically. A three-step pipeline where each step has 90% structural stability has only a 73% end-to-end success rate. Five steps: 59%. Determinism is the foundational reliability metric for any agentic workload.

This is covered in depth in [[courses/picking-a-frontier-model-2026-q2/02-tool-use-determinism-benchmark|Chapter 2]].

### 2. Context fidelity at depth

The ability to accurately retrieve and reason about information that appears in the *middle* of a long context window. All three frontier models exhibit "lost-in-the-middle" degradation — accuracy at retrieval drops as documents are buried deeper in the context. The key question is not *how large* the context window is, but *how reliably* the model retrieves from different positions within it. [6]

### 3. Structured-output reliability

The fraction of responses that parse cleanly as valid JSON (or whatever schema you specify) without requiring retry or post-processing. Related to determinism but distinct: a model can be deterministic in *which* keys it returns while still producing malformed JSON on 5% of calls. High structured-output reliability reduces retry costs and simplifies error handling.

### 4. Latency at your percentile

Not average latency — your 95th or 99th percentile latency under realistic concurrency. For a customer-facing feature, a 2-second average with a 12-second p99 may be worse than a 3-second average with a 5-second p99. Latency is workload-specific and cannot be read from a spec sheet.

### 5. Cost-per-task (not cost-per-token)

The true cost to complete one unit of your workload, accounting for retry rates, prompt caching hit rates, and tool-call overhead. A cheaper model with higher retry rates can easily cost more per task than an expensive model with near-perfect reliability. Covered in [[courses/picking-a-frontier-model-2026-q2/04-cost-per-task|Chapter 4]].

<Callout type="warn">
**Don't conflate output length with output quality.** A model that produces verbose responses to fill its context window may score better on human preference evaluations (more detail looks more helpful) while performing *worse* on structured tasks (more tokens = more surface area for schema violations). Always filter preference benchmarks by task type before using them to inform production decisions.
</Callout>

---

## The 3 dimensions you can probably ignore

Not everything matters equally. Here are three dimensions frequently cited in benchmark tables that correlate weakly with most production workloads:

### 1. Aggregate reasoning score (MMLU, GPQA)

Unless your use case involves answering graduate-level science questions or broad knowledge recall, a 3-point delta in aggregate reasoning score is noise compared to a 5% difference in tool-use determinism. These scores are useful for tracking model *progress over time*, not for choosing between current-generation frontier models.

### 2. Peak performance on hard problems

"The model can solve competition math" is a capability, not a production metric. Peak capability tells you the ceiling; it says nothing about the floor. For most production workloads, the floor (what happens on the 10% of prompts where the model struggles) matters more than the ceiling.

### 3. Multilingual performance (unless your product is multilingual)

If you're building an English-language product, a model's Chinese or Arabic benchmark scores are irrelevant. Benchmark tables aggregate across many settings; make sure the dimension being measured applies to your actual distribution.

---

## Building your scorecard

The scorecard is a simple forcing function: before you run any benchmark, you write down which dimensions matter for your use case and how much you weight them. This prevents the common failure mode of running a benchmark, seeing that one model wins on latency, and anchoring on that — ignoring that your use case is latency-tolerant but determinism-critical.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I'm building a coding agent that reads a GitHub issue, calls 3–5 tools (file read, grep, test run, PR create), and produces a pull request. Help me build a weighted evaluation scorecard for this use case. The scorecard should have 5 dimensions selected from: [tool-use determinism, context fidelity at depth, structured-output reliability, latency p95, cost-per-task, multilingual performance, aggregate reasoning score, peak math performance]. For each dimension you include, give it a weight (1–5) and explain in one sentence why that weight is appropriate for this use case. Format as a markdown table."
  expectedOutput="The model should produce a table weighting tool-use determinism and structured-output reliability highest (4–5), cost-per-task and context fidelity at medium (3), latency at lower priority (2, since async PRs are latency-tolerant), and excluding multilingual and peak math. If it weights differently, that's worth examining — the model's reasoning reveals assumptions about your use case that you should validate."
/>

A well-built scorecard has three properties:
1. **Weights reflect your production SLA, not generic impressiveness.** A latency-tolerant batch job should weight determinism higher than latency.
2. **It includes a disqualifier.** At least one dimension where a failing score eliminates a model regardless of other scores. For a tool-use pipeline, a determinism score below 85% is typically a disqualifier.
3. **It is written before you see the benchmark results.** Post-hoc scorecards unconsciously anchor on the model you already prefer.

---

## Use-case archetypes

Most production AI workloads fall into one of three archetypes. Use these as a starting point for your scorecard, then customize.

| Archetype | Top dimension | Second dimension | Common disqualifier |
|---|---|---|---|
| **Coding agent** (multi-step, tool-heavy) | Tool-use determinism | Structured-output reliability | Determinism < 85% |
| **Document Q&A** (long-context, synthesis) | Context fidelity at depth | Cost-per-task | Lost-needle rate > 10% at target depth |
| **High-volume classification** (batch, latency-tolerant) | Cost-per-task | Structured-output reliability | Cost-per-task > 2× competitor |

If your use case maps cleanly to one of these archetypes, you already know your top dimensions. If it doesn't — if you're building something latency-critical *and* tool-heavy *and* long-context — you have a hard evaluation problem and should expect to make tradeoffs rather than finding a model that wins on all axes.

---

## Hands-on exercise

**Build a scorecard for your use case.**

1. Choose one of the three archetypes above as your starting point, or describe your own use case in 2–3 sentences.
2. Select 5 dimensions from this list: `tool-use determinism`, `context fidelity at depth`, `structured-output reliability`, `latency p95`, `cost-per-task`, `multilingual performance`, `aggregate reasoning score`.
3. Assign each a weight from 1 (nice to have) to 5 (critical). Total weight must equal 15.
4. For each dimension with weight ≥ 4, write one sentence explaining *why* it is high-priority for your use case.
5. Identify one disqualifier: a minimum threshold on one dimension below which you would not use a model regardless of its scores on other dimensions.

**Verification**: Your scorecard is valid if:
- Exactly 5 dimensions are listed
- Weights sum to 15
- At least one dimension has weight ≥ 4 with a written justification
- A disqualifier is named

**Estimated time**: 15 minutes

<KnowledgeCheck
  question="A team is building an async batch pipeline that classifies customer support tickets into 12 categories. Each ticket is 200–500 words. The pipeline runs overnight. Which evaluation dimension should receive the highest weight in their scorecard?"
  options={[
    "Latency p95 — faster responses mean the batch finishes sooner",
    "Cost-per-task — batch jobs process millions of tickets; per-unit cost dominates",
    "Tool-use determinism — the model must call tools to classify accurately",
    "Context fidelity at depth — each ticket is long and requires deep reading"
  ]}
  correctIdx={1}
  explanation="Batch pipelines are latency-tolerant (overnight run), so latency p95 is low priority. Classification without tool calls means tool-use determinism is less relevant. Each ticket is short (200–500 words), so context depth is not a concern. Cost-per-task is the dominant variable: a 20% cost delta across millions of daily classifications is a significant budget line item. The correct weight is: cost-per-task #1, structured-output reliability #2 (the 12-category output must parse cleanly), latency last."
/>

<KnowledgeCheck
  question="You've just filled in your scorecard and given 'aggregate reasoning score (MMLU)' a weight of 4 out of 5 for a customer support bot use case. Write 1–2 sentences defending or revising this choice."
  options={["self-check"]}
  correctIdx={0}
  explanation="A weight of 4 on MMLU for a customer support bot is almost certainly too high. Customer support bots answer questions about your product, policies, and tickets — tasks driven by retrieval and structured-output reliability, not graduate-level reasoning. MMLU measures broad knowledge recall across 57 academic domains. Unless your customer support involves novel scientific reasoning (rare), a more defensible weight would be 1–2, with the freed weight reassigned to structured-output reliability or tool-use determinism."
/>

---

## What's next

Chapter 1 gave you the framework: five production dimensions, three benchmarks to deprioritize, and a scorecard template for your workload. You now have a hypothesis about which dimensions matter most for your use case — but a hypothesis is not evidence.

In [[courses/picking-a-frontier-model-2026-q2/02-tool-use-determinism-benchmark|Chapter 2]], you'll run the 10×3×5 benchmark that measures the dimension most commonly overlooked in public comparisons: tool-use determinism. You'll run it across Opus 4.7, GPT-5.5, and Gemini 3.1 Pro on a reference prompt set — and optionally add 2 prompts from your own use case.

---

## References

[1] Hendrycks, D. et al. (2021). "Measuring Massive Multitask Language Understanding." ICLR 2021 — https://arxiv.org/abs/2009.03300 · retrieved 2026-04-30

[2] Chen, M. et al. (2021). "Evaluating Large Language Models Trained on Code." OpenAI — https://arxiv.org/abs/2107.03374 · retrieved 2026-04-30

[3] Koenig AI Academy internal benchmark data, Q2 2026 — /data/claude-tool-use-determinism/2026-Q2/ · retrieved 2026-04-30

[4] Patil, S. et al. Berkeley Function-Calling Leaderboard (BFCL) V4 — https://gorilla.cs.berkeley.edu/leaderboard.html · retrieved 2026-04-30

[5] OpenAI. Introducing GPT-5.5 — https://openai.com/index/introducing-gpt-5-5/ · retrieved 2026-04-30

[6] Liu, N. et al. (2023). "Lost in the Middle: How Language Models Use Long Contexts" — https://arxiv.org/abs/2307.03172 · retrieved 2026-04-30

[7] Anthropic. Claude models overview — context windows and specifications — https://docs.anthropic.com/en/docs/about-claude/models/overview · retrieved 2026-04-30

[8] Google. Gemini 3.1 Pro model specification — https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-pro · retrieved 2026-04-30

[9] Anthropic. Prompt caching — https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching · retrieved 2026-04-30

[10] OpenAI. Prompt caching in the API — https://openai.com/index/api-prompt-caching/ · retrieved 2026-04-30

[11] Google. Context caching overview (Gemini API) — https://ai.google.dev/gemini-api/docs/caching · retrieved 2026-04-30
