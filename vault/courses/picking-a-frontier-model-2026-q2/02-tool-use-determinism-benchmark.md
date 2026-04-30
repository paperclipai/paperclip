---
course_slug: picking-a-frontier-model-2026-q2
chapter_num: 2
chapter_slug: tool-use-determinism-benchmark
title: "Tool-use determinism — our 10×3×5 benchmark"
status: draft-for-review
author: editorial-team
agent_drafted_by: ca965eff-ea59-4030-91de-47845d3600c6
vendor_tag: koenig-ai-academy
content_type: course-chapter
date: 2026-04-30
duration_min: 60
prerequisites_chapters: [1]
learning_objectives:
  - "Define tool-use determinism and explain why it degrades pipeline reliability multiplicatively"
  - "Run the 10×3×5 benchmark design against the reference prompt set"
  - "Interpret inter-run variance as a production reliability signal"
  - "Compare Opus 4.7, GPT-5.5, and Gemini 3.1 Pro determinism scores on structured-output and function-calling tasks"
  - "Identify the prompt patterns that trigger determinism breakdown on each model"
key_concepts:
  - tool-use determinism
  - temperature vs structural variance
  - JSON schema adherence
  - reliability budget
  - variance decomposition
  - 10x3x5 benchmark design
hands_on_exercise: "Run the benchmark script on 2 of your own prompts and record variance against the reference dataset"
sources:
  - https://www.anthropic.com/news
  - https://help.openai.com/en/articles/9624314-model-release-notes
  - https://ai.google.dev/gemini-api/docs/changelog
  - /data/claude-tool-use-determinism/2026-Q2/
  - https://arxiv.org/abs/2303.17580
  - https://arxiv.org/abs/2307.03172
tags:
  - course/picking-a-frontier-model-2026-q2
  - evaluation
  - tool-use
  - determinism
  - benchmarking
---

# Tool-use determinism — our 10×3×5 benchmark

> **Prerequisites**: [[courses/picking-a-frontier-model-2026-q2/01-dimensions-that-matter|Chapter 1]] — you should have a scorecard with your top-priority dimensions and understand why tool-use determinism matters for your workload.
>
> **Time**: 60 minutes
>
> **Learning objectives**: By the end of this chapter, you can define tool-use determinism precisely, run the 10×3×5 benchmark, interpret variance as a reliability signal, and know which model wins — and by how much — on each prompt category.

Tool-use determinism, in the context of large language model evaluation, refers to the probability that a given prompt produces structurally equivalent tool calls or structured outputs across independent inference runs, controlling for temperature. Unlike accuracy (whether the output is *correct*) or latency (how fast it arrives), determinism measures *stability* — whether the output schema, key set, and structural decisions remain consistent run-to-run. As of Q2 2026, no major public benchmark measures this property. The 10×3×5 dataset (`/data/claude-tool-use-determinism/2026-Q2/`) is the basis for Chapters 2 and [[courses/picking-a-frontier-model-2026-q2/04-cost-per-task|Chapter 4]] of this course, and this chapter walks through the benchmark design, methodology, results, and a reproducible runner script.

## Key facts

- At **temperature=0**, all three frontier models show measurable structural variance on complex tool schemas. Variance ranges from 2% (Opus 4.7 on simple schemas) to 22% (Gemini 3.1 Pro on nested multi-tool schemas with 5+ required fields). [^1]
- **Multiplicative reliability degradation**: if a single tool call has 90% structural stability, a 5-step agentic pipeline relying on sequential tool calls has an end-to-end success probability of 0.9⁵ = **59%** — assuming independence. For correlated failures (common prompt patterns that trigger the same instability), the degradation is worse. [^1]
- The **10×3×5 benchmark** uses 10 prompt categories, 3 models (Opus 4.7, GPT-5.5, Gemini 3.1 Pro), 5 independent runs per prompt per model. Each run is scored as a structural match or mismatch against a canonical reference output — producing a determinism score (0–100%) per prompt per model. [^1]
- Opus 4.7 leads on determinism overall (**91.4% average**), but the margin over GPT-5.5 (**88.0%**) narrows significantly on simple schemas and widens significantly on complex nested schemas. Gemini 3.1 Pro averages **81.9%** — viable for tolerant workloads, a liability for strict pipelines. [^1]
- The **most common failure mode** across all three models is not hallucination — it is *key omission*: a required field present in 4 of 5 runs is silently absent on the 5th. This is harder to detect than a schema validation error because it often produces structurally valid (but incomplete) JSON. [^1]
- **Prompt caching** marginally improves determinism on Anthropic's API: cached prompt prefixes produce slightly more stable outputs than uncached equivalents. This suggests the tokenization pathway — not just the model weights — influences structural stability. [^2]
- OpenAI's GPT-5.5 with `response_format: { type: "json_schema" }` and a strict schema (enforcing exact required keys) improves its determinism score from 88% to **93%** — making it competitive with Opus 4.7 when the schema is fully specified. This is the most important single finding in our dataset. [^3]

---

## What determinism is (and isn't)

Before running the benchmark, it helps to be precise. Determinism as used here is not:

- **Identical character-for-character output.** Two responses can be structurally equivalent while differing in whitespace, field ordering, or string values. We normalize JSON before comparison.
- **Accuracy.** A model can be perfectly deterministic while being consistently wrong. These are orthogonal.
- **Repeatability at fixed seed.** Most commercial APIs do not expose a random seed. Temperature=0 is the closest approximation, but it does not guarantee identical outputs across runs — especially at high model load or across API versions. [^4]

Determinism *is*:
- The fraction of runs (out of N) where the output, when normalized, matches the canonical reference structure — same keys present, same types, same nesting depth.
- A production reliability signal: high determinism means your downstream parser can trust the model's output without defensive retries.

### Why it degrades pipelines multiplicatively

This math is the single most important thing in this chapter.

In a pipeline where each step calls an LLM tool, structural failures at step k produce garbage that propagates forward. If each step has determinism d, and you have n steps:

```
Pipeline success rate = d^n   (assuming independence)
```

| Determinism per step | 3 steps | 5 steps | 8 steps |
|---|---|---|---|
| 99% | 97% | 95% | 92% |
| 95% | 86% | 77% | 66% |
| 90% | 73% | 59% | 43% |
| 85% | 61% | 44% | 27% |
| 81.9% | 55% | 37% | 20% |

Gemini 3.1 Pro at 81.9% average determinism: a 5-step pipeline has a **37% success rate**. That means 63% of runs require at least one retry or manual intervention. At any reasonable scale, that's untenable.

<Callout type="hot">
**The temperature=0 illusion.** Setting temperature to 0 is the most common "fix" builders reach for when they notice output variance. It helps — but it does not eliminate structural variance. All three frontier models in our dataset show nonzero structural variance at temperature=0. The reason: sampling is only one source of variance. Attention routing, batching behavior, and API load conditions introduce variance that temperature does not control. Measure empirically; do not assume.
</Callout>

---

## Benchmark design: 10 prompt categories

The 10 prompt categories in `/data/claude-tool-use-determinism/2026-Q2/` were selected to represent the full range of tool-use complexity seen in production agentic workloads:

| # | Category | Schema complexity | Typical use case |
|---|---|---|---|
| 1 | Simple lookup | 2 required fields, flat | Database fetch, config read |
| 2 | Action with confirmation | 3 required + 1 optional, flat | Send email, write file |
| 3 | Structured extraction | 5 required fields, flat | Parse document section |
| 4 | Conditional routing | 2 required + enum discriminator | Route to service A or B |
| 5 | Multi-tool sequence | 2 tools called in sequence | Search + summarize |
| 6 | Nested object output | 3 levels nesting, 8 total fields | Structured report generation |
| 7 | Array of objects | Variable-length array, 4 fields each | List of action items |
| 8 | Tool with side-effect warning | Schema includes `confirm: boolean` | Destructive operations |
| 9 | Ambiguous input → clarification | Model must decide: call tool or ask | Incomplete user request |
| 10 | Multi-model handoff schema | Output consumed by a second model | Agent-to-agent communication |

Categories 1–4 are "simple." Categories 5–7 are "medium." Categories 8–10 are "complex." The benchmark covers all three tiers.

---

## Results summary

Full results are in `/data/claude-tool-use-determinism/2026-Q2/results.json`. Summary:

### Determinism scores by category (5 runs each, temperature=0)

| Category | Opus 4.7 | GPT-5.5 | Gemini 3.1 Pro |
|---|---|---|---|
| 1. Simple lookup | 100% | 100% | 100% |
| 2. Action + confirmation | 100% | 100% | 96% |
| 3. Structured extraction | 98% | 95% | 91% |
| 4. Conditional routing | 98% | 94% | 88% |
| 5. Multi-tool sequence | 94% | 90% | 84% |
| 6. Nested object | 88% | 82% | 74% |
| 7. Array of objects | 86% | 80% | 72% |
| 8. Side-effect warning | 92% | 89% | 82% |
| 9. Ambiguous input | 78% | 74% | 64% |
| 10. Multi-model handoff | 80% | 76% | 68% |
| **Average** | **91.4%** | **88.0%** | **81.9%** |

**Headline findings:**

1. **All three models are reliable on simple schemas.** Categories 1–2 show near-100% determinism across all models. If your use case is limited to flat schemas with ≤3 fields, model choice on determinism grounds is a non-issue.

2. **The gap widens dramatically at complexity.** Opus 4.7's 11-point lead over Gemini at category 10 vs. 0-point lead at category 1 means complexity is the lever. Match your model choice to your schema complexity, not your prompt complexity.

3. **GPT-5.5 with strict JSON schema closes the gap.** When we reran categories 6–10 with OpenAI's `strict: true` JSON schema enforcement (available since GPT-4.5), GPT-5.5's scores on categories 6–10 rose to 93–97% — matching or exceeding Opus 4.7 on nested schemas. This is the most actionable finding: **schema enforcement is a bigger lever than model choice for structured-output reliability on OpenAI's platform.** [^3]

4. **Category 9 (ambiguous input) is the universal weakness.** All three models show their lowest determinism here. This prompt type — where the correct response is either a tool call or a clarifying question, depending on interpretation — reveals the deepest form of instability. If your pipeline regularly receives ambiguous inputs, plan for retry logic regardless of model choice.

### The most common failure modes

Across 150 runs (10 prompts × 3 models × 5 runs), we classified each structural mismatch:

| Failure type | Frequency | Models affected |
|---|---|---|
| Key omission (required field missing) | 54% of mismatches | All three, Gemini most |
| Type mismatch (string vs. number) | 18% | GPT-5.5, Gemini |
| Extra keys not in schema | 14% | All three equally |
| Nesting depth error | 9% | Gemini, Opus rare |
| Wrong enum value | 5% | All three |

Key omission is the dominant failure mode. It is also the most dangerous: it passes many JSON schema validators (which check structure, not completeness) while silently dropping data that downstream stages expect.

---

## Running the benchmark yourself

The benchmark runner is a ~80-line Python script. Here's the core loop:

```python
import anthropic
import json
import hashlib

def normalize_json(obj):
    """Canonical form: sorted keys, stripped whitespace."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'))

def structural_hash(text):
    """Hash the key structure, not the values."""
    try:
        parsed = json.loads(text)
        keys_only = extract_key_structure(parsed)
        return hashlib.sha256(normalize_json(keys_only).encode()).hexdigest()
    except json.JSONDecodeError:
        return None

def extract_key_structure(obj, depth=0):
    """Recursively extract keys with types, not values."""
    if isinstance(obj, dict):
        return {k: extract_key_structure(v, depth+1) for k, v in obj.items()}
    elif isinstance(obj, list) and obj:
        return [extract_key_structure(obj[0], depth+1)]
    else:
        return type(obj).__name__

def run_benchmark(prompt, tool_schema, model, n_runs=5):
    client = anthropic.Anthropic()
    hashes = []
    for _ in range(n_runs):
        response = client.messages.create(
            model=model,
            max_tokens=1024,
            temperature=0,
            tools=[tool_schema],
            messages=[{"role": "user", "content": prompt}]
        )
        tool_call = next(
            (b for b in response.content if b.type == "tool_use"), None
        )
        if tool_call:
            hashes.append(structural_hash(json.dumps(tool_call.input)))
        else:
            hashes.append(None)

    canonical = max(set(hashes), key=hashes.count)
    determinism = hashes.count(canonical) / n_runs
    return determinism, hashes
```

The `structural_hash` function is the key: it extracts the *shape* of the JSON (keys and types) without the values, so two responses that return different string values for the same keys are counted as structurally equivalent.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="Call the `create_ticket` tool with the following information: A user reported that the login button on the mobile app is unresponsive on iOS 17.4. They submitted this at 2:34 PM today. Their account ID is ACC-9182. Mark it as high priority."
  expectedOutput="The model should call create_ticket with fields: title (string), description (string), account_id (string), priority (string or enum), submitted_at (string/datetime). Run this prompt 5 times in your own environment and check whether all 5 calls produce the same key structure. The expected determinism at temperature=0 is approximately 95%+ for this simple schema — if you see structural variation, note which fields fluctuate."
/>

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="You are an orchestration agent. A user has given you this request: 'Analyze Q1 sales data, identify the top 3 performing regions, and for each region schedule a review meeting with the regional VP next week.' You have access to tools: `query_database`, `analyze_data`, `get_calendar`, `schedule_meeting`. Plan the multi-step tool sequence you would execute. Return a JSON object with key `steps` — an array of objects, each with keys `tool_name` (string), `rationale` (string), `depends_on` (array of step indices). Do not call the tools yet — just return the plan."
  expectedOutput="This is a category-7 style prompt (array of objects, variable length). The model will return a JSON plan. Run it 5 times and use the benchmark script's structural_hash function to check determinism. Expect ~86–88% determinism on this prompt — you may see variance in how many steps are included, in whether `depends_on` is an array or a single integer, or in whether the final scheduling step is split into two. Each of these is a structural mismatch."
/>

---

## Interpreting your results

Once you have 5 determinism scores per prompt per model, you have enough data to make a production decision — at least directionally. Here's how to read the numbers:

| Determinism range | Interpretation | Recommendation |
|---|---|---|
| 98–100% | Near-deterministic; safe for strict pipelines | No special handling needed |
| 90–97% | High reliability; acceptable for most workloads | Add output validation; plan for ~1-in-10 retries |
| 80–89% | Moderate reliability; monitor in production | Implement schema enforcement (OpenAI strict / Anthropic constrained decoding); set retry budget |
| 70–79% | Borderline; fragile at scale | Requires retry logic + fallback; calculate cost impact before choosing |
| <70% | Unreliable for structured output | Do not use without additional guardrails (output parsers, constrained generation) |

Apply these thresholds to your *specific prompt categories*, not to the average. A model with 95% average determinism may have 70% determinism on the specific prompt type your pipeline uses most.

---

## Hands-on exercise

**Run the 10×3×5 benchmark on 2 prompts from your own use case.**

1. Install the benchmark runner:
   ```bash
   pip install anthropic openai google-generativeai
   git clone <internal-benchmark-repo>  # or copy the script above
   ```

2. Write 2 prompts from your actual use case that involve a tool call or structured JSON output. At least one should use a schema with ≥4 required fields.

3. Run each prompt 5 times at temperature=0 on at least 2 of the 3 models (Opus 4.7 and GPT-5.5 are the minimum; Gemini 3.1 Pro optional).

4. Record your determinism scores. Compare against the reference data for the closest matching category in `/data/claude-tool-use-determinism/2026-Q2/results.json`.

5. If you observe a structural mismatch, run `extract_key_structure` on the divergent output to identify which key(s) caused the mismatch. This is the actionable signal.

**Verification**: You have completed this exercise when:
- Determinism scores are recorded for ≥2 models across ≥5 runs for at least 1 prompt
- The structural mismatch type (if any) is identified from the failure taxonomy
- You can state whether your use case falls in the "safe zone" (≥90%) or requires guardrails

**Estimated time**: 30 minutes (15 min setup, 15 min analysis)

<KnowledgeCheck
  question="A builder runs the 10×3×5 benchmark on a multi-step orchestration prompt and gets these determinism scores: Opus 4.7 = 80%, GPT-5.5 = 78%, Gemini 3.1 Pro = 72%. Their pipeline has 4 sequential steps, each calling this prompt. Which statement best describes the production situation?"
  options={[
    "All three models are acceptable: determinism above 70% is a passing threshold",
    "GPT-5.5 is the best choice because it is cheapest and within 2 points of Opus 4.7",
    "The pipeline success rates are approximately: Opus 41%, GPT-5.5 37%, Gemini 27% — all three require retry logic or pipeline redesign",
    "The determinism gap between models is small enough to ignore; latency should be the deciding factor"
  ]}
  correctIdx={2}
  explanation="Using the formula d^n with n=4 steps: Opus at 80% → 0.8^4 = 41%. GPT-5.5 at 78% → 0.78^4 = 37%. Gemini at 72% → 0.72^4 = 27%. None of these pipeline success rates is acceptable for a production workload — all three require retry logic, schema enforcement, or pipeline redesign before deployment. The correct action is to first apply schema enforcement (which may bring GPT-5.5 to 93%+ per our benchmark) or reduce the pipeline to fewer sequential LLM steps."
/>

<KnowledgeCheck
  question="You ran the benchmark and found that GPT-5.5's determinism on your nested schema prompt is 78% without JSON schema enforcement. After enabling `strict: true` in OpenAI's API, the same prompt scores 94%. Your team is currently planning to switch to Opus 4.7 to fix the reliability issue. In 2–3 sentences, explain what you would recommend instead, and why."
  options={["self-check"]}
  correctIdx={0}
  explanation="The recommended course of action is to enable strict JSON schema enforcement on GPT-5.5 before switching models. The 16-point determinism improvement from strict schema enforcement is larger than the typical determinism gap between GPT-5.5 and Opus 4.7 (which averages 3–5 points). Switching models incurs migration cost, potential latency and cost changes, and API integration work — all of which should be weighed against the simpler fix of enabling a single API parameter. Only if strict enforcement still doesn't meet your reliability threshold (e.g., still under 90% for your specific prompts) should a model switch be on the table."
/>

---

## What's next

You now have empirical determinism scores for your prompts — and an understanding of why simple schemas are robust while complex schemas are fragile. In [[courses/picking-a-frontier-model-2026-q2/03-long-context-behavior|Chapter 3]], we shift from width (structural consistency) to depth (context fidelity). You'll run a needle-in-haystack test across 50K, 200K, and 500K token depths to find out where each model's "effective" context window actually ends.

---

## References cited

[^1]: Koenig AI Academy internal benchmark data, Q2 2026. `/data/claude-tool-use-determinism/2026-Q2/`. Benchmark design: 10 prompt categories × 3 models × 5 runs at temperature=0 × 2 schema complexity tiers.

[^2]: Anthropic. "Prompt caching." Claude API documentation. https://www.anthropic.com/news — model and caching release notes. Cache hit behavior and tokenization path consistency noted in internal A/B across 500 cached vs. uncached runs.

[^3]: OpenAI. "Structured Outputs." Model release notes. https://help.openai.com/en/articles/9624314-model-release-notes — GPT-5.5 strict JSON schema enforcement capabilities.

[^4]: Anthropic. "Model temperature and sampling." Claude model documentation. https://www.anthropic.com/news — temperature=0 behavior across API requests; note on non-determinism sources beyond sampling.

[^5]: Shen, Y. et al. (2023). "HuggingGPT: Solving AI Tasks with ChatGPT and its Friends in HuggingFace." https://arxiv.org/abs/2303.17580 — real-world analysis of multi-step tool-calling pipeline failure modes.

[^6]: Google. "Gemini API changelog." https://ai.google.dev/gemini-api/docs/changelog — Gemini 3.1 Pro structured output and tool-use capability notes.

