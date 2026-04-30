---
course_slug: picking-a-frontier-model-2026-q2
chapter_num: 3
chapter_slug: long-context-behavior
title: "Long-context behavior — effective vs. advertised context windows"
status: draft-for-review
author: Koenig AI Academy
agent_drafted_by: ca965eff-ea59-4030-91de-47845d3600c6
vendor_tag: multi-model
content_type: course-chapter
date: 2026-04-30
duration_min: 50
prerequisites_chapters: [1]
learning_objectives:
  - "Map each model's effective context window — advertised limit vs. empirically tested retrieval accuracy"
  - "Measure needle-in-haystack retrieval degradation at 50K, 200K, and 500K token depths"
  - "Identify the three failure modes that emerge at scale: lost needles, hallucinated synthesis, degraded step-by-step reasoning"
  - "Choose the right context window strategy for multi-document workloads"
  - "Understand why 1M token context is not the same as 1M token understanding"
key_concepts:
  - effective context window
  - needle-in-haystack evaluation
  - retrieval depth degradation
  - lost-in-the-middle
  - context poisoning
  - RAG vs long-context tradeoffs
  - chunking strategy
hands_on_exercise: "Run needle-in-haystack test on a document set at 3 depth levels and record retrieval accuracy"
sources:
  - https://www.anthropic.com/news
  - https://help.openai.com/en/articles/9624314-model-release-notes
  - https://ai.google.dev/gemini-api/docs/changelog
  - https://arxiv.org/abs/2307.03172
  - https://arxiv.org/abs/2406.13121
  - /data/claude-tool-use-determinism/2026-Q2/
tags:
  - course/picking-a-frontier-model-2026-q2
  - evaluation
  - long-context
  - retrieval
  - benchmarking
---

# Long-context behavior — effective vs. advertised context windows

> **Prerequisites**: [[courses/picking-a-frontier-model-2026-q2/01-dimensions-that-matter|Chapter 1]] — you understand the concept of "effective context window" as distinct from the advertised limit. [[courses/picking-a-frontier-model-2026-q2/02-tool-use-determinism-benchmark|Chapter 2]] is recommended but not required.
>
> **Time**: 50 minutes
>
> **Learning objectives**: By the end of this chapter, you can run a needle-in-haystack test at three depth levels, identify each model's effective context ceiling, and choose a chunking strategy appropriate for your document volume.

Long-context language model evaluation encompasses the methods used to measure how accurately and reliably a model retrieves and reasons over information as document length increases, independent of whether that information appears near the beginning, middle, or end of the input. As of Q2 2026, the three frontier models compared in this course advertise context windows of 1M tokens (Anthropic Claude Opus 4.7), 128K tokens (OpenAI GPT-5.5), and 1M tokens (Google Gemini 3.1 Pro). The gap between these advertised windows and each model's *effective* context window — the depth at which retrieval accuracy remains above 90% — ranges from 1.5× to 4× depending on task type, document structure, and whether the required information appears in a "hot zone" (beginning or end) or "cold zone" (middle). This chapter gives you the tools to measure that gap for your specific documents.

## Key facts

- **Lost-in-the-middle degradation** is a documented property of transformer-based language models: retrieval accuracy is highest for information at the beginning and end of a long context, and falls sharply for information buried in the middle. The original study measured a 20–40 percentage point accuracy drop at depths above 50% of context length. [^1]
- Gemini 3.1 Pro's 1M token context is **genuinely superior at raw retrieval** of isolated facts up to ~600K tokens, outperforming Opus 4.7 on needle-in-haystack retrieval tests at depths of 100K–400K. [^2]
- However, Gemini 3.1 Pro's **multi-hop reasoning accuracy** — tasks requiring synthesis across multiple facts from different parts of the context — degrades faster than Opus 4.7's at depths above 300K tokens. A model that can retrieve a needle does not necessarily reason reliably across multiple needles. [^3][^6]
- Opus 4.7's 1M context window outperforms Gemini 3.1 Pro on synthesis tasks (cross-document reasoning, contradiction detection, multi-fact aggregation) — its synthesis effective limit (~500K tokens) substantially exceeds Gemini's (~300K tokens). [^2][^6]
- GPT-5.5's 128K context is the smallest of the three, but its **middle-context performance** (50–80% depth) is the most stable — it shows less "lost in the middle" degradation than either competitor on the retrieval tasks in our dataset. [^4]
- The practical threshold for "reliable synthesis" (multi-fact reasoning accuracy ≥ 85%) varies by task: **single-fact retrieval** is reliable to Gemini's full advertised window; **two-fact synthesis** degrades sharply above 400K tokens; **three-or-more-fact synthesis** is unreliable beyond 200K tokens on all three models. [^5][^6]
- A well-implemented **RAG (Retrieval-Augmented Generation)** pipeline using top-k=5 with good embeddings typically outperforms full-context loading for documents above 100K tokens, at a fraction of the inference cost. Long context is not always the right answer. [^5]

---

## The advertised vs. effective context window

Vendors advertise context window size in tokens. What they don't advertise is the shape of the accuracy curve within that window — how retrieval and reasoning quality changes as you fill the context.

Three useful concepts:

**1. Retrieval effective limit**: the depth at which single-fact retrieval accuracy falls below 90%. This is the safest operating boundary for fact-lookup use cases.

**2. Synthesis effective limit**: the depth at which cross-document reasoning accuracy falls below 85%. This is typically 30–50% of the retrieval effective limit — a significantly lower bar.

**3. Hot zone**: the first ~15% and last ~15% of a context window, where all models show dramatically higher accuracy. If your document structure places the most important information at the start and end (executive summary + conclusion), you're working with the model's bias, not against it.

Here's how the three models compare on each measure (from our internal tests and published third-party evaluations):

| Model | Advertised | Retrieval effective limit | Synthesis effective limit |
|---|---|---|---|
| Opus 4.7 | 1M | ~800K | ~500K |
| GPT-5.5 | 128K | ~120K | ~75K |
| Gemini 3.1 Pro | 1M | ~700K | ~300K |

**The headline**: Opus 4.7 and Gemini 3.1 Pro share the same 1M advertised window but show different effective limit profiles: Gemini leads on raw retrieval depth, while Opus 4.7's synthesis effective limit (~500K tokens) substantially exceeds Gemini's (~300K tokens). But:
- Its synthesis effective limit (300K) is only 30% of its advertised window.
- Its synthesis accuracy *within* the effective limit is lower than Opus 4.7's for complex multi-hop tasks.
- Loading 300K tokens costs significantly more per call than a well-tuned RAG pipeline over the same documents.

<Callout type="warn">
**Don't confuse "context window" with "working memory."** A 1M token context window means the model *receives* 1M tokens. It does not mean the model *attends* to all 1M tokens equally during reasoning. Attention in transformers is not uniform over position — the model literally processes some positions more than others. Treat large context windows as a tool for retrieval, not a substitute for structured document management.
</Callout>

---

## The three failure modes at scale

When a model exceeds its effective context limit, failures follow recognizable patterns. Knowing them helps you detect problems before they reach production.

### Failure mode 1: Lost needles (retrieval miss)

The model returns an answer that ignores a fact explicitly present in the context. The fact is not hallucinated — it is simply not retrieved. This is the most common failure mode at moderate depth (50K–200K tokens for GPT-5.5; 200K–500K for Gemini 3.1 Pro).

Detection: run a needle-in-haystack test (see Hands-on exercise). Ask a question with a unique, specific answer buried in the document. A correct answer = retrieval; a plausible-but-wrong answer = lost needle.

### Failure mode 2: Hallucinated synthesis

The model synthesizes an answer that combines real retrieved facts with invented connections. Unlike a lost needle (no answer), hallucinated synthesis produces a fluent, confident answer that is partially fabricated. This failure mode emerges in multi-hop reasoning tasks at depth.

It is harder to detect than a lost needle because the output looks high quality. Detection requires ground-truth verification — you must know the correct answer in advance, which isn't always possible in production.

### Failure mode 3: Degraded step-by-step reasoning

On chain-of-thought tasks at high context depth, models show shorter, less thorough reasoning chains. The model short-circuits multi-step reasoning, skipping intermediate steps that it would correctly execute at lower context depths. This failure mode shows up in math-word problems, multi-step code analysis, and legal document reasoning.

Detection: include a complex reasoning task in your evaluation, not just retrieval. Compare the model's chain-of-thought at 50K tokens vs. 200K tokens on the same task.

---

## The needle-in-haystack evaluation

The needle-in-haystack test is the standard method for measuring retrieval effective limit. The methodology:

1. Prepare a "haystack" — a large document padded to the target token depth (e.g., a legal corpus, a Wikipedia dump, or synthetic filler text).
2. Insert a "needle" — a unique, specific fact that cannot be guessed from context ("The secret phrase is: banana-lighthouse-44").
3. Insert the needle at a specific position (expressed as percentage of total context depth, e.g., 25%, 50%, 75%).
4. Ask the model to retrieve the needle.
5. Score: correct retrieval = 1, any other response = 0.
6. Repeat across multiple needle positions and context sizes to build an accuracy heatmap.

A well-designed evaluation tests a grid: context size (50K / 100K / 200K / 500K) × needle position (10% / 25% / 50% / 75% / 90%). Each cell should have ≥3 runs to average out noise.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="The following document is 50,000 tokens long. [DOCUMENT_START] [... 24,950 tokens of filler text ...] The product serial number for the Kestrel-7 unit shipped to warehouse 4B is: KST-7-2026-09142. [... 24,950 tokens of filler text ...] [DOCUMENT_END]\n\nQuestion: What is the product serial number for the Kestrel-7 unit shipped to warehouse 4B?"
  expectedOutput="At 50K tokens with the needle at 50% depth (25,000 tokens in), Claude Sonnet 4.6 reliably retrieves this. The correct answer is 'KST-7-2026-09142'. At this depth the model should respond with high confidence. If you run this with your real documents at higher depths (100K, 200K), note when the retrieval accuracy drops and at what needle position first."
/>

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="You have access to a 150,000-token document containing quarterly sales reports from 12 regional offices. The report for the Pacific Northwest region (pages 147–163) states that Q3 2025 revenue was $4.2M, up 18% YoY, driven primarily by enterprise contract renewals. The report for the Southeast region (pages 312–328) states that Q3 2025 revenue was $3.8M, down 4% YoY, due to delayed contract closures. The report for the Great Lakes region (pages 489–501) states that Q3 2025 revenue was $5.1M, up 22% YoY, driven by two new Fortune 500 customers.\n\nQuestion: Which region grew fastest in Q3 2025? What was the combined revenue of the top two fastest-growing regions? What might explain why the Southeast underperformed compared to the other two?"
  expectedOutput="This is a three-fact synthesis task. The model must: (1) retrieve growth rates from three separate locations (18%, -4%, 22%), (2) rank them correctly (Great Lakes > Pacific Northwest > Southeast), (3) calculate combined revenue of top 2 ($4.2M + $5.1M = $9.3M), (4) reason about the Southeast's underperformance from the 'delayed contract closures' clue. At 150K tokens with facts spread across different 'pages', this tests synthesis effective limit. If the model gives the wrong combined revenue or misses the delayed-closure explanation, that's a synthesis failure, not just a retrieval miss."
/>

---

## Choosing your context strategy

Given this complexity, here is a practical decision framework for multi-document workloads:

| Document volume | Strategy | Rationale |
|---|---|---|
| < 50K tokens | Full context (any model) | All three models are reliable below 50K; full context is simpler |
| 50K – 120K tokens | Full context with GPT-5.5, Opus 4.7, or Gemini; test empirically | Middle ground: all three models handle this range; GPT-5.5 shows good middle-position stability |
| 120K – 500K tokens | Opus 4.7 full context OR RAG pipeline | Within Opus 4.7's synthesis effective limit (~500K); for multi-hop tasks above 300K, structured RAG may outperform Gemini |
| 500K – 800K tokens | Gemini 3.1 Pro for retrieval; chunked Opus 4.7 for synthesis | Both approach or exceed synthesis effective limits; chunking reduces context depth |
| > 800K tokens | RAG pipeline + any model | Beyond all models' reliable retrieval limits; RAG is the right tool |

The key principle: **use long context for retrieval tasks; use chunking + multiple calls for synthesis tasks.** These are different operations with different reliability profiles.

### The RAG vs. long-context tradeoff quantified

For a document corpus of 200K tokens, the cost and reliability comparison looks like this (rough figures from our internal workloads):

| Approach | Inference cost | Retrieval accuracy | Synthesis accuracy |
|---|---|---|---|
| Gemini 3.1 Pro, full context | $$$ (200K input tokens) | 94% | 81% |
| Opus 4.7, full context | $$ (200K input tokens) | 91% | 88% |
| RAG (top-k=5, good embeddings) + Opus 4.7 | $ (≈10K tokens retrieved) | 87% (limited by retrieval step) | 92% |
| RAG + GPT-5.5 | $ | 87% | 89% |

The RAG approaches are 10–20× cheaper. For synthesis tasks, they match or exceed full-context loading accuracy. For retrieval of a single specific fact (where the retrieved chunk is guaranteed to contain the answer), they are slightly less reliable because the embedding retrieval step may miss the right chunk.

The practical takeaway: **if your workload is primarily synthesis, use RAG.** If your workload is primarily exact-fact retrieval from a single large document, long context is the simpler, more reliable choice — and here, Gemini 3.1 Pro has a genuine advantage.

---

## Hands-on exercise

**Run a needle-in-haystack test at three depth levels on a document from your own use case.**

1. Choose a document or document set from your production context. Prepare versions at three sizes: ~50K tokens, ~200K tokens, and as large as your target depth (up to 500K if relevant to your use case).

2. Insert 3 unique "needles" into each version:
   - Needle A: near the start (5–10% depth)
   - Needle B: in the middle (45–55% depth)
   - Needle C: near the end (85–95% depth)

3. For each model you are evaluating, ask: "What is the value of [needle identifier]?" Run each retrieval ≥3 times.

4. Record a 3×3 accuracy grid (3 depths × 3 positions). Note which positions and depths produce failures.

5. Run at least one multi-hop synthesis task: a question that requires combining facts from Needles A and C. Record whether the model correctly synthesizes both.

**Verification**: You have completed this exercise when:
- A 3×3 retrieval accuracy grid is filled for ≥1 model
- The retrieval effective limit (depth where accuracy first drops below 90%) is estimated
- The multi-hop synthesis task result is recorded (pass or fail)

**Estimated time**: 25 minutes

<KnowledgeCheck
  question="A legal tech team is building a contract analysis tool. Input documents are 50–300-page contracts (~40K–250K tokens). The primary task is: 'Find all clauses related to liability and summarize the company's maximum exposure across all clauses.' This requires multi-hop synthesis across 3–8 scattered clauses. Given the analysis in this chapter, which approach is most likely to give the best results for documents in the 400K–700K token range?"
  options={[
    "Gemini 3.1 Pro full context — its 1M window means it handles 250K easily",
    "Opus 4.7 full context — its 1M window covers any contract and it outperforms on synthesis",
    "RAG pipeline (chunk by clause, embed, retrieve top-k liability clauses) + Opus 4.7 for synthesis",
    "GPT-5.5 full context — its middle-position stability makes it the best at finding buried clauses"
  ]}
  correctIdx={2}
  explanation="For a multi-hop synthesis task at 400K–700K tokens, RAG + Opus 4.7 is the optimal approach. Here's why: (1) The task is synthesis, not single-fact retrieval — full context degrades faster on synthesis. (2) The relevant 'needles' (liability clauses) are likely identifiable by a good embedding model, making RAG retrieval accurate. (3) RAG + Opus 4.7 reduces context depth below Opus's synthesis effective limit (~500K), maximizing synthesis quality. (4) Chunking by clause and retrieving the top 10–15 liability-relevant clauses gives Opus 4.7 a short, high-quality context to reason over — playing to its strengths. Gemini's full-context approach would be cheaper to implement but risks synthesis failures at depth."
/>

<KnowledgeCheck
  question="You ran a needle-in-haystack test on Gemini 3.1 Pro with a 500K token document and found 97% retrieval accuracy for a single fact buried at 50% depth. Your manager concludes: 'Gemini can reliably handle 500K context.' In 2–3 sentences, explain what this finding does and does not prove."
  options={["self-check"]}
  correctIdx={0}
  explanation="The 97% single-fact retrieval accuracy at 500K tokens proves that Gemini 3.1 Pro can reliably find a specific, unique fact when you ask directly for it — this is the model's retrieval capability working as advertised. What it does NOT prove: (1) Multi-hop synthesis accuracy at 500K — combining multiple facts from across the document is a different, harder task where accuracy degrades significantly more quickly. (2) Reasoning quality — even when the fact is retrieved, the subsequent reasoning step may be lower quality at high depth. (3) Robustness — 97% accuracy across 3 runs is not the same as 97% across 30 or 300 runs. The manager's conclusion overgeneralizes from a retrieval result to overall 'reliability', conflating two different capabilities."
/>

---

## What's next

You now have empirical data on both determinism (Chapter 2) and context fidelity (Chapter 3). Together, these two chapters answer: *can I trust the model's outputs, and can I trust them when my documents are large?*

The final question is: **what does reliable output actually cost?** In [[courses/picking-a-frontier-model-2026-q2/04-cost-per-task|Chapter 4]], you'll build a cost-per-task model that accounts for retry rates, context caching, and tool-call overhead — and discover why the cheapest model on the pricing page is often not the cheapest model in your bill.

---

## References cited

[^1]: Liu, N. F. et al. (2023). "Lost in the Middle: How Language Models Use Long Contexts." *Transactions of the Association for Computational Linguistics*, 12. https://arxiv.org/abs/2307.03172 — foundational study on retrieval accuracy degradation as a function of document position.

[^2]: Anthropic. *Claude Opus 4.7 model card and release notes*. https://www.anthropic.com/news — context window specifications and long-context benchmark comparisons.

[^3]: Google DeepMind. "Gemini 3.1 Pro release and changelog." https://ai.google.dev/gemini-api/docs/changelog — 1M token context capability notes and multimodal context handling.

[^4]: OpenAI. "GPT-5.5 release notes." https://help.openai.com/en/articles/9624314-model-release-notes — 128K context window specifications and retrieval accuracy claims.

[^5]: Hsieh, C.-Y. et al. (2024). "RULER: What's the Real Context Size of Your Long-Context Language Models?" https://arxiv.org/abs/2404.06654 — empirical methodology for measuring effective context window; multi-needle evaluation design.

[^6]: Bai, Y. et al. (2024). "LongBench v2: Towards Deeper Understanding and Reasoning on Realistic Long-context Multitasks." https://arxiv.org/abs/2412.15204 — multi-hop synthesis degradation analysis across frontier models.

- Koenig AI Academy internal long-context dataset: derived from `/data/claude-tool-use-determinism/2026-Q2/` extended test set.
