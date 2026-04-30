---
course_slug: picking-a-frontier-model-2026-q2
chapter_num: 4
chapter_slug: cost-per-task
title: "Cost-per-task — pricing vs. actual bill on real workloads"
status: draft-for-review
author: editorial-team
agent_drafted_by: ca965eff-ea59-4030-91de-47845d3600c6
vendor_tag: koenig-ai-academy
content_type: course-chapter
date: 2026-04-30
duration_min: 50
prerequisites_chapters: [1, 2, 3]
learning_objectives:
  - "Calculate cost-per-task from token counts and retry rates — not just $/M token list pricing"
  - "Account for prompt caching, tool-call overhead, and retry costs in a realistic cost model"
  - "Compare total cost of ownership across Opus 4.7, GPT-5.5, and Gemini 3.1 Pro for three workload archetypes"
  - "Build a break-even analysis: at what reliability delta does the cheaper model become more expensive?"
  - "Identify the pricing surprises that catch builders off-guard"
key_concepts:
  - cost-per-task model
  - prompt caching economics
  - retry cost amplification
  - total cost of ownership
  - break-even reliability analysis
  - context caching
  - pricing surprises
hands_on_exercise: "Fill in the cost estimator spreadsheet for your use case using real token counts from Chapter 2"
sources:
  - https://www.anthropic.com/pricing
  - https://openai.com/pricing
  - https://ai.google.dev/pricing
  - https://www.anthropic.com/news
  - https://help.openai.com/en/articles/9624314-model-release-notes
  - https://ai.google.dev/gemini-api/docs/changelog
tags:
  - course/picking-a-frontier-model-2026-q2
  - evaluation
  - cost
  - pricing
  - benchmarking
---

# Cost-per-task — pricing vs. actual bill on real workloads

> **Prerequisites**: [[courses/picking-a-frontier-model-2026-q2/01-dimensions-that-matter|Chapter 1]] required; Chapters 2 and 3 recommended for the best practical grounding. You should have token counts from at least one benchmark run.
>
> **Time**: 50 minutes
>
> **Learning objectives**: By the end of this chapter, you can calculate a defensible cost-per-task number for your workload, account for retries and caching, and know when the "cheaper" model is actually more expensive.

Cost-per-task is the total monetary cost to complete one end-to-end unit of a production AI workload — including all input tokens, output tokens, tool-call overhead, retries from failed or malformed outputs, and prompt cache misses. It is distinct from the $/M token pricing listed on vendor pricing pages, which measures the raw cost of tokens in isolation and ignores the factors that dominate real bills: retry rates driven by output instability, context caching economics, and the hidden token amplification from multi-step tool use. As of Q2 2026, the per-token pricing landscape is: OpenAI GPT-5.5 is the most expensive per token; Google Gemini 3.1 Pro is the cheapest; Claude Opus 4.7 sits in the middle. But across real tool-use workloads, the cost ordering by cost-per-task is often the opposite of the cost ordering by $/M token. This chapter shows why.

## Key facts

- **Opus 4.7 list pricing** (Q2 2026): $5/M input tokens, $25/M output tokens. Prompt cache write: $6.25/M; cache read: $0.50/M (90% discount vs. uncached input). [^1]
- **GPT-5.5 list pricing**: $10/M input tokens, $40/M output tokens. Cached input: $5/M (50% discount). [^2]
- **Gemini 3.1 Pro list pricing**: $2.00/M input tokens, $12.00/M output tokens. Context caching (via Google Cloud): $0.20/M cached tokens. [^3]
- On a simple prompt with no retries, **Gemini 3.1 Pro is 2.5× cheaper per input token and ~2× cheaper per output token** than Opus 4.7. This is the number that appears in comparison articles.
- In our 10×3×5 benchmark, Gemini 3.1 Pro's average determinism was **81.9%** versus Opus 4.7's **91.4%**. At 5-step pipelines, that translates to a **2× difference in pipeline success rate** (31% vs. 61%) — each failed run requiring a full retry.
- A failed pipeline run at Gemini pricing ($2/M input) still costs real money: retries are not free. When you factor retry rates into the cost model, Gemini 3.1 Pro's effective cost-per-successful-task is significantly higher than its per-token price implies.
- **The biggest hidden cost is prompt caching misses.** A typical agentic system sends the same large system prompt on every call. Without caching, you pay full input price on every turn. With caching, you pay 10% (Anthropic) or 50% (OpenAI) on repeated tokens. This difference dominates cost for multi-turn systems.
- **Tool-call tokens are not free.** Each tool definition included in the API call is tokenized and billed as input tokens. A system with 10 tool definitions (~600 tokens of schema) adds $0.009 per call at Opus pricing — small per call, but $9 per 1,000 calls, which compounds at scale.

---

## Why pricing pages are misleading

The standard model comparison table presents:

| Model | Input $/M | Output $/M |
|---|---|---|
| Opus 4.7 | $5 | $25 |
| GPT-5.5 | $10 | $40 |
| Gemini 3.1 Pro | $2.00 | $12.00 |

This table is accurate. It is also nearly useless for production cost planning, because it omits:

1. **Retry rate**: how often does a failed/malformed output require a retry call?
2. **Prompt caching hit rate**: what fraction of input tokens are cached vs. billed at full price?
3. **Tool-call token overhead**: how many tokens are consumed by tool definitions in every call?
4. **Output amplification**: multi-step pipelines generate output at each step that becomes input at the next. The output/input token ratio compounds.
5. **Context window efficiency**: at high context depths, some models produce lower-quality outputs that require verification calls, adding latency and cost.

A real cost model accounts for all of these. The simplified formula:

```
cost_per_task = (
    prompt_tokens_uncached × input_price
  + prompt_tokens_cached × cache_price
  + output_tokens × output_price
  + tool_tokens × input_price
) × (1 / determinism_rate)^pipeline_steps
```

The last factor — `(1 / determinism_rate)^pipeline_steps` — is the retry multiplier. It is the single biggest source of divergence between pricing page cost and actual bill.

---

## The retry multiplier in practice

Let's run the math for a representative 3-step tool-use pipeline:

- System prompt: 2,000 tokens
- User message: 200 tokens
- Tool definitions: 800 tokens
- Output per step: 400 tokens
- Steps: 3

**Without caching, no retries (baseline):**

| Model | Per-step input cost | Per-step output cost | 3-step total |
|---|---|---|---|
| Opus 4.7 | (3,000 tokens) × $5/M = $0.015 | 400 × $25/M = $0.010 | **$0.075** |
| GPT-5.5 | (3,000) × $10/M = $0.030 | 400 × $40/M = $0.016 | **$0.138** |
| Gemini 3.1 Pro | (3,000) × $2/M = $0.006 | 400 × $12/M = $0.0048 | **$0.032** |

Gemini is 2.3× cheaper than Opus with no retries. This is the number in the comparison article.

**Now apply determinism-driven retries from our benchmark data:**

For a 3-step pipeline at category-5 complexity (multi-tool sequence), the determinism scores were: Opus 94%, GPT-5.5 90%, Gemini 84%.

Pipeline success probability: Opus 0.94³ = 83%, GPT-5.5 0.90³ = 73%, Gemini 0.84³ = 59%.

Expected calls to complete one successful pipeline run = 1 / success_probability:

| Model | Per-run cost (no retry) | Expected runs to success | **Cost-per-successful-task** |
|---|---|---|---|
| Opus 4.7 | $0.075 | 1.20 | **$0.090** |
| GPT-5.5 | $0.138 | 1.37 | **$0.189** |
| Gemini 3.1 Pro | $0.032 | 1.69 | **$0.054** |

Gemini is still cheapest — but the ratio has compressed from 2.3× to 1.7×. And this is at category-5 complexity. At category-9 (ambiguous input), where Gemini's determinism drops to 64%:

| Model | Determinism (cat-9) | 3-step success | Calls to success | Cost-per-task |
|---|---|---|---|---|
| Opus 4.7 | 78% | 47% | 2.1 | **$0.158** |
| GPT-5.5 | 74% | 41% | 2.4 | **$0.331** |
| Gemini 3.1 Pro | 64% | 26% | 3.8 | **$0.122** |

At ambiguous-input prompts, you need 3.8 Gemini calls to get one successful pipeline completion — and each retry potentially compounds errors (some retries don't fail cleanly; they produce partial outputs that corrupt the pipeline state). The real cost is even higher than the formula predicts once you add retry-handling logic and partial-failure recovery.

### When the math flips: 10-step pipelines at ambiguous-input complexity

The retry multiplier grows **exponentially** with pipeline length: it scales as `1 / determinism^n`. A 14-point determinism gap (Opus 78% vs. Gemini 64%) is small at 3 steps — it produces a 1.8× difference in expected call count. At 10 steps, the same gap produces a **7.2× difference**. That exponential behavior is why pricing pages are structurally incapable of predicting your actual bill.

Here is the full calculation for a 10-step pipeline at category-9 complexity (ambiguous-input, multi-tool sequence). Because each step's output joins the context for the next step, input tokens grow with each step. The profile below assumes 3,000 base tokens (system + user + tools) and 400 tokens of accumulated output carried forward per step:

| Step | Accumulated input tokens |
|---|---|
| Step 1 | 3,000 |
| Step 2 | 3,400 |
| Step 3 | 3,800 |
| … | … |
| Step 10 | 6,600 |

Total input across all 10 steps: **48,000 tokens**. Total output: **4,000 tokens**.

**Per-run cost (10 steps, no retries yet):**

| Model | Input cost | Output cost | Per-run total |
|---|---|---|---|
| Opus 4.7 | 48,000 × $5/M = $0.240 | 4,000 × $25/M = $0.100 | **$0.340** |
| GPT-5.5 | 48,000 × $10/M = $0.480 | 4,000 × $40/M = $0.160 | **$0.640** |
| Gemini 3.1 Pro | 48,000 × $2/M = $0.096 | 4,000 × $12/M = $0.048 | **$0.144** |

Gemini is still 2.4× cheaper per run. Now apply determinism:

**10-step pipeline success at category-9 (ambiguous-input) complexity:**

| Model | Per-step determinism | 10-step success (det^10) | Expected runs to success | Cost-per-successful-task |
|---|---|---|---|---|
| Opus 4.7 | 78% | 0.78¹⁰ = **8.3%** | 12.0 | **$4.08** |
| GPT-5.5 | 74% | 0.74¹⁰ = **5.1%** | 19.6 | **$12.54** |
| Gemini 3.1 Pro | 64% | 0.64¹⁰ = **1.15%** | 86.7 | **$12.48** |

The cost ordering has **inverted**. Gemini — the model with list pricing 2.5× below Opus — costs **3× more** per successful task than Opus when the pipeline is long enough and the input is ambiguous. GPT-5.5 and Gemini are nearly tied. The cheapest-per-token model is the most expensive per task.

The break-even for this pipeline profile occurs between 4 and 5 steps. At 4 steps, Gemini ($0.286/task) and Opus ($0.302/task) are nearly equal. Beyond 5 steps, Opus wins on cost-per-task. This is not a corner case — any multi-agent coding or reasoning system with error handling, tool-selection, and planning stages will routinely hit 5–10 action steps per task.

<Callout type="hot">
**The inversion is real, and it has a break-even you can calculate.** At category-9 complexity (ambiguous-input, multi-tool), Gemini 3.1 Pro crosses above Opus 4.7 in cost-per-task at pipeline length ≥ 5 steps. If your agentic system has 5+ action steps on hard inputs — and most production coding agents do — the pricing page comparison is actively misleading. Run your determinism scores through the retry multiplier before making a cost decision.
</Callout>

---

## Prompt caching: the underrated cost lever

Prompt caching is the most impactful cost optimization most builders aren't fully using.

The economics: if you have a 10,000-token system prompt (common in agentic systems with tool definitions and long context instructions), and your system makes 10,000 calls per day:

| Model | Without caching | With caching | Daily savings |
|---|---|---|---|
| Opus 4.7 | 10K × $5/M = $0.05/call × 10K = $500/day | 10K × $0.50/M = $0.005/call × 10K = $50/day | **$450/day** |
| GPT-5.5 | 10K × $10/M = $0.10/call × 10K = $1,000/day | 10K × $5/M = $0.05/call × 10K = $500/day | **$500/day** |
| Gemini 3.1 Pro | 10K × $2/M × 10K = $200/day | 10K × $0.20/M × 10K = $20/day | **$180/day** |

Anthropic's caching gives a **90% discount** on cached tokens — matching Google's 90% discount on Gemini context caching, and significantly better than OpenAI's 50%. A Gemini-vs-Opus comparison without caching shows a 2.5× price advantage. A comparison with caching and a 10K-token system prompt shows the same 2.5× ratio — both platforms discount cached tokens by 90%, so the relative cost is unchanged by caching alone. [^1]

### Caching gotchas

Each platform has rules that break caching in non-obvious ways:

**Anthropic (Opus 4.7)**:
- Cache TTL: 5 minutes. Calls more than 5 minutes apart from the same prompt restart the cache. For batch workloads with irregular timing, cache hit rate can be much lower than expected.
- Minimum cacheable length: 1,024 tokens. Short system prompts don't qualify.
- Cache is per-user/session: if you're building a multi-tenant system, you need to architect for per-tenant cache keys.

**OpenAI (GPT-5.5)**:
- Cache minimum: 128 tokens. More permissive.
- Cache discount: 50% (vs. Anthropic's 90%). Meaningful, but less impactful.
- Caching applies automatically to the prompt prefix; no explicit cache-control API.

**Google (Gemini 3.1 Pro)**:
- Context caching requires explicit cache creation via the API — it's not automatic.
- Cached contexts have a configurable TTL and must be managed explicitly. This is more work to implement but gives you more control.
- The separate caching pricing ($0.20/M vs. $2/M uncached input — a 90% discount) is competitive for large, stable system prompts.

---

## The three workload archetypes, costed

Applying the full cost model to the three archetypes from [[courses/picking-a-frontier-model-2026-q2/01-dimensions-that-matter|Chapter 1]]:

### Archetype A: Coding agent (multi-step, tool-heavy)

Representative call profile:
- System prompt: 8,000 tokens (tool definitions + instructions), cached after first call
- Average input per turn: 3,000 tokens (code context)
- Average output: 800 tokens (code + reasoning)
- Steps per task: 5
- Determinism requirement: uses category 5–7 schemas

| Model | Determinism (5-step success) | Cost per successful task (with caching) |
|---|---|---|
| Opus 4.7 | ~86% (0.86⁵ = 47%) | ~$0.42 |
| GPT-5.5 + strict | ~93% (0.93⁵ = 70%) | ~$0.73 |
| Gemini 3.1 Pro | ~79% (0.79⁵ = 31%) | ~$0.28 |

**Recommendation**: Gemini 3.1 Pro is cheapest per successful task at $0.28, but the 31% pipeline success rate demands robust retry infrastructure. Opus 4.7 at $0.42 offers a reasonable cost/reliability balance with 47% success. GPT-5.5 with `strict: true` delivers the best pipeline success (70%) but costs 74% more than Opus. Choose GPT-5.5 if reliability is non-negotiable; Opus for a balanced default; Gemini only if you have retry infrastructure in place.

### Archetype B: Document Q&A (long-context, single query)

Representative call profile:
- Document: 80K tokens (one call, no caching)
- System prompt: 500 tokens
- Output: 600 tokens
- Steps: 1 (no pipeline)

| Model | Cost per call | Notes |
|---|---|---|
| Opus 4.7 | $0.415 | $80K × $5/M + 600 × $25/M |
| GPT-5.5 | $0.824 | $80K × $10/M + 600 × $40/M |
| Gemini 3.1 Pro | $0.167 | $80K × $2/M + 600 × $12/M |

For single-query long-context Q&A with no pipeline and no retries, **Gemini 3.1 Pro's cost advantage is largest here** (2.5× cheaper than Opus). The single-step nature means determinism variance doesn't compound. If retrieval accuracy (not synthesis) is the primary task, Gemini's combination of cheapness + large context window wins clearly.

### Archetype C: High-volume classification (batch, 10M items/month)

Representative call profile:
- Input: 300 tokens per item
- System prompt: 1,000 tokens (same for all items, cached)
- Output: 50 tokens
- Steps: 1, structured output required

At 10M items/month:

| Model | Monthly cost (no retries) | With 5% retry rate |
|---|---|---|
| Opus 4.7 | ~$77K/month | ~$81K |
| GPT-5.5 | ~$151K/month | ~$160K |
| Gemini 3.1 Pro | ~$32K/month | ~$34K |

For classification at this scale, **Gemini 3.1 Pro wins decisively** — saving $45K/month vs. Opus 4.7. The structured-output task (12-category classification) uses a simple flat schema (category 1–2 in our benchmark), where Gemini's determinism is 96–100% — effectively eliminating the retry-rate advantage of more expensive models.

**The unified lesson**: the right model depends on your archetype. Gemini for simple-schema, high-volume, or long-context retrieval. GPT-5.5 with strict schema for complex tool-use pipelines. Opus 4.7 for use cases where determinism on complex schemas is non-negotiable and retry cost is prohibitive.

---

## Hands-on exercise

**Build a cost-per-task model for your use case using your Chapter 2 benchmark data.**

Use this spreadsheet template (fill in your numbers):

```
=== COST MODEL WORKSHEET ===

USE CASE: [describe in 1 sentence]

TOKEN COUNTS (from your Chapter 2 benchmark run):
  System prompt tokens: ___
  Average user message tokens: ___
  Tool definition tokens: ___
  Average output tokens: ___
  Pipeline steps: ___

CACHING:
  Is system prompt ≥ 1024 tokens? [Y/N]
  Estimated cache hit rate (% of calls): ___ %
  (For Anthropic: use 80% if calls are within 5-minute windows; 40% if irregular)

DETERMINISM SCORES (from your Chapter 2 run):
  Model A (Opus 4.7): ___ %
  Model B (GPT-5.5): ___ %
  Model C (Gemini 3.1 Pro): ___ %

COST FORMULA (per model):
  input_cost = (system_prompt × (1 - cache_hit_rate) × INPUT_PRICE)
             + (system_prompt × cache_hit_rate × CACHE_PRICE)
             + (message_tokens + tool_tokens) × INPUT_PRICE
  output_cost = output_tokens × OUTPUT_PRICE
  retry_multiplier = 1 / (determinism ^ pipeline_steps)
  cost_per_task = (input_cost + output_cost) × retry_multiplier × pipeline_steps

RESULTS:
  Opus 4.7 cost-per-task: $___
  GPT-5.5 cost-per-task: $___
  Gemini 3.1 Pro cost-per-task: $___

RECOMMENDATION: [which model and why, in 1 sentence]
```

**Verification**: Your cost model is complete when:
- All token counts are from actual benchmark runs (not guesses)
- Cache hit rate reflects your actual call pattern
- Cost-per-task accounts for retries using your measured determinism scores
- You can state which model wins on cost-per-task and by what margin

**Estimated time**: 20 minutes

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I'm building a cost model for an AI customer support system. Here are my numbers: system prompt = 3,000 tokens (same for all calls, high cache hit rate ~85%), average customer message = 400 tokens, tool definitions = 1,200 tokens, average response = 600 tokens, pipeline steps = 2. Determinism scores from my benchmark: Opus 4.7 = 94%, GPT-5.5 = 91%, Gemini 3.1 Pro = 85%. Using these current approximate prices — Opus 4.7: $5/$25 per M input/output, GPT-5.5: $10/$40, Gemini 3.1 Pro: $2.00/$12.00 — and Anthropic's cache read price of $0.50/M, GPT-5.5 cached input $5/M, and Gemini cached input $0.20/M — calculate cost-per-task for each model including retries. Show your working."
  expectedOutput="The model should walk through the calculation for each of the three providers, applying the cache hit rate to the system prompt, then computing per-step cost, then applying the retry multiplier (1 / determinism^2). Expected output: Opus cost-per-task ≈ $0.025–0.035; GPT-5.5 ≈ $0.130–0.145; Gemini ≈ $0.030–0.040. Opus and Gemini are the closest pair because both platforms apply a 90% cache discount, while GPT-5.5's 50% discount is less effective. The retry multiplier slightly closes the Opus–Gemini gap (Gemini has lower determinism). This is the core illustration of why pricing pages mislead: GPT-5.5 appears competitive on the list price table but costs 2–3× more than Opus once caching and retries are modelled."
/>

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="My team is debating whether to switch from Gemini 3.1 Pro to Opus 4.7 for a high-volume document classification pipeline. We process 500,000 documents per day. Each document averages 800 tokens of input, and we use a 2,000-token system prompt that stays constant. Output is ~100 tokens. We have a 90% cache hit rate. Our current Gemini bill is approximately $53,000/month (Gemini 3.1 Pro: $2/M input, $12/M output, $0.20/M cached). Gemini's determinism on our classification schema is 92%. Opus 4.7's determinism is 97% (Opus 4.7: $5/M input, $25/M output, $0.50/M cached). Neither model is failing enough to cause production issues — we have retry logic that handles failures. Should we switch? What's the monthly cost difference, and does the determinism improvement justify the switch?"
  expectedOutput="The model should compute: Gemini monthly cost (with 90% cache, 500K docs/day × 30 days = 15M docs/month, ~800 tokens each + 2K system prompt) ≈ $53K/month. Opus 4.7 monthly cost at the same volume ≈ $126K/month. At these determinism levels (92% vs 97%), the retry multiplier difference is small (1.087 vs 1.031) — less than 6%. The monthly cost of Opus 4.7 vs Gemini 3.1 Pro at this volume is dramatically different (Opus is ~2.5× more expensive in input tokens, with the same 90% cache discount on both). The recommendation should be: do not switch. The 5-point determinism improvement does not justify a $73K/month increase when retry logic is already handling failures and neither model is causing production SLA breaches."
/>

<KnowledgeCheck
  question="A startup is choosing between Gemini 3.1 Pro ($2/M input) and Opus 4.7 ($5/M input) for a 4-step agentic coding pipeline. Their benchmark shows Gemini determinism = 82% and Opus determinism = 91% on their prompt types. Which statement is true about the expected cost-per-task comparison?"
  options={[
    "Gemini is always cheaper because its per-token price is 2.5× lower, regardless of determinism",
    "Opus is cheaper because its higher determinism means fewer retries, more than offsetting the higher price",
    "The expected number of Gemini runs to complete one task is ~1.5×, narrowing but not eliminating its cost advantage",
    "Determinism doesn't affect cost because retries use only output tokens, which are the same fraction of total cost"
  ]}
  correctIdx={2}
  explanation="4-step pipeline success: Gemini 0.82⁴ = 45%, so expected runs = 1/0.45 ≈ 2.2. Opus 0.91⁴ = 68%, expected runs = 1/0.68 ≈ 1.47. Gemini needs ~1.5× more runs than Opus per successful task. That partially offsets Gemini's 2.5× per-token input price advantage. The cost-per-task ratio compresses from ~2.3× (pricing page, blended input+output) to roughly ~1.5×. Gemini is still cheaper — but by a meaningfully smaller margin than the pricing page implies. Option A is wrong (determinism clearly affects cost). Option B is wrong (the math shows Gemini is still cheaper per task despite more retries). Option D is wrong (retries require re-sending the full input, not just output tokens)."
/>

<KnowledgeCheck
  question="After building your cost model, you find that Opus 4.7 costs $0.42/task and Gemini 3.1 Pro costs $0.28/task for your coding agent workload. Your company processes 50,000 tasks/month. A teammate argues: 'We should use Gemini — we save $7,000/month.' You notice that your Chapter 2 benchmark showed Gemini's pipeline success rate is 31% vs. Opus's 61%. Write 2–3 sentences evaluating the teammate's argument, including any cost factor they may have omitted."
  options={["self-check"]}
  correctIdx={0}
  explanation="The teammate's calculation is directionally correct on raw inference cost but omits the engineering cost of handling a 69% pipeline failure rate. At 31% pipeline success (Gemini), 34,500 of 50,000 monthly tasks fail at least once — each requiring retry logic, error handling, partial-state recovery, and possibly human review. The engineering cost of building and maintaining that infrastructure, plus the latency cost to users waiting on retries, should be quantified before accepting the $7,000/month savings. A more complete comparison would factor in: developer time to build retry/recovery (~20–40 engineering hours = $3,000–6,000 in team cost), user-facing latency increase on retries, and on-call burden from elevated failure rates. The teammate's conclusion may still be right — but the decision requires a total cost of ownership calculation, not just an inference cost comparison."
/>

---

## What's next

You have now completed all four analytical chapters. You have:
- A scorecard weighted for your use case (Chapter 1)
- Empirical determinism scores for your prompts (Chapter 2)
- Context fidelity data at your target document depth (Chapter 3)
- A cost-per-task model with retry rates and caching (Chapter 4)

The capstone project synthesizes all four into a **model selection memo** — a 500–800 word document your engineering manager could read and act on. The memo format is in `vault/courses/picking-a-frontier-model-2026-q2/outline.md`.

For further reading on how these models perform on specific workloads, see [[blogs/opus-4-7-long-running-coding-benchmark]] and [[blogs/gpt-5-5-in-codex]] in the Academy vault.

---

## References cited

[^1]: Anthropic. "Claude pricing." https://www.anthropic.com/pricing — Opus 4.7 input/output/cache pricing as of Q2 2026. Also: "Prompt caching." https://www.anthropic.com/news.

[^2]: OpenAI. "OpenAI API pricing." https://openai.com/pricing — GPT-5.5 input/output/cached input pricing as of Q2 2026. Model release notes: https://help.openai.com/en/articles/9624314-model-release-notes.

[^3]: Google. "Gemini API pricing." https://ai.google.dev/pricing — Gemini 3.1 Pro input/output/context caching pricing as of Q2 2026. Changelog: https://ai.google.dev/gemini-api/docs/changelog.

[^4]: Koenig AI Academy internal cost model data, Q2 2026. Derived from 10×3×5 benchmark dataset (`/data/claude-tool-use-determinism/2026-Q2/`) with retry simulation applied at workload scale.

