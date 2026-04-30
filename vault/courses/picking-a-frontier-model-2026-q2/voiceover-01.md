---
course_slug: picking-a-frontier-model-2026-q2
chapter_num: 1
type: voiceover-script
duration_sec: 280
word_count: 420
speaker: nova-warm
---

# Voiceover Script: Chapter 1 — The dimensions that matter

---

Welcome to *Picking a Frontier Model*. I'm your guide through the practical art of evaluating AI models not by their benchmark scores, but by their performance on *your* production workload.

As of Q2 2026, three models dominate serious AI applications: Claude Opus 4.7, GPT-5.5, and Google's Gemini 3.1 Pro. Each ships with a comparison table: MMLU scores, HumanEval results, GPQA rankings. But here's the honest truth: those benchmarks measure research progress, not production fitness.

Your coding agent doesn't answer multiple-choice questions about high school biology. It calls tools with JSON schemas. It retrieves facts from documents you provide. It produces outputs that downstream code must parse. The standard benchmarks? They don't measure any of that.

This chapter teaches you what actually matters.

We've analyzed 12 months of production AI workloads. Five dimensions consistently separate the models in ways that predict success:

**First: Tool-use determinism.** The probability that the same prompt at the same temperature produces structurally equivalent output across independent runs. If a three-step agentic pipeline has 90% structural stability at each step, you're down to 73% end-to-end success. Determinism compounds.

**Second: Context fidelity at depth.** All frontier models exhibit degradation when retrieving information buried in the middle of a long context. The question isn't how large the window is—it's how reliably the model retrieves from different positions within it.

**Third: Structured-output reliability.** The fraction of responses that parse as valid JSON without retry or post-processing. Related to determinism, but distinct: a model can be consistent while still producing malformed JSON on five percent of calls.

**Fourth: Latency at your percentile.** Not average latency—your 95th or 99th percentile response time under realistic load. A 2-second average with a 12-second p99 may be worse than a 3-second average with a 5-second p99.

**Fifth: Cost-per-task.** Not cost-per-token. The true cost to complete one unit of your workload, accounting for retry rates, caching hit rates, and tool-call overhead. A cheaper model with higher failure rates can cost far more per task than an expensive reliable model.

Three dimensions you can probably ignore: aggregate reasoning scores like MMLU and GPQA—unless your use case is answering graduate-level science questions—peak performance on competition math, and multilingual capabilities if you're building an English-only product.

The scorecard is a forcing function. Before you run any benchmark, write down which dimensions matter for your use case and how much you weight them. This prevents the failure mode of running a benchmark, seeing one model win on latency, and anchoring on that result while ignoring dimensions that actually matter for your reliability.

In Chapter 2, you'll run a real benchmark that measures the dimension most commonly overlooked: tool-use determinism. You'll see how Opus, GPT, and Gemini actually perform when it counts.

---

**Metadata**
- **Script words**: 420
- **Estimated spoken duration** (1.0x speed): ~280 seconds (4.7 minutes)
- **Voice**: Nova (warm, tutor preset for Academy courses)
- **Next action**: Produce voiceover-01.mp3 via Kokoro; normalize to -16 LUFS
