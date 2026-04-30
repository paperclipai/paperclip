---
title: "Tool-use determinism — our 10×3×5 benchmark (voiceover script)"
course_slug: picking-a-frontier-model-2026-q2
chapter_num: 2
chapter_slug: tool-use-determinism-benchmark
voice_preset: nova-warm
estimated_duration_sec: 580
word_count: 1450
status: ready-for-synthesis
date: 2026-04-30
---

# Voiceover script — Chapter 2: Tool-use determinism

**[INTRO — 0:00]**

You're building a multi-step agent. Each step calls a model, parses the JSON output, and feeds it forward. Simple architecture. But here's the catch: the model doesn't return *identical* JSON every time. Same prompt, temperature zero—but on the fourth run, a required field vanishes. On the fifth run, it's back.

That instability is tool-use determinism. And it's about to cost you a lot more than you think.

**[THE PROBLEM — 0:30]**

Let's do the math. Say each step in your pipeline has 90% determinism—meaning the output structure matches what you expect 9 out of 10 times. That's pretty good, right? Wrong.

For a 5-step pipeline, you multiply: 0.9 to the fifth power equals 59%. Fifty-nine percent. That means *almost half your runs fail at least once* and need a retry. For an 8-step pipeline, it drops to 43%. At 85% per-step determinism on 5 steps, you're down to 44%. At Gemini's average of 79% on a 5-step pipeline—you're at 31%. That means 69% of runs require at least one retry or manual intervention.

This is the multiplicative reliability trap. It compounds silently, and most builders don't see it until they hit production.

**[WHAT DETERMINISM IS — 1:30]**

Before we look at results, let's be precise—because the definition matters.

Determinism as we measure it is *not* identical character-for-character output. Two responses can differ in whitespace, field ordering, or string values while being structurally equivalent. We normalize JSON before comparison. It's also not accuracy—a model can be perfectly deterministic while being consistently wrong. Those are orthogonal properties. And it's not repeatability at a fixed seed: most commercial APIs don't expose one. Temperature zero is our closest approximation, but it does not guarantee identical outputs across runs—especially at high model load or across API versions.

What determinism *is*: the fraction of runs, out of N, where the output matches the canonical reference structure—same keys present, same types, same nesting depth. That's it. It's a production reliability signal. High determinism means your downstream parser can trust the model without defensive retries.

Here's the important implication about temperature zero. Setting temperature to zero is the first thing most builders try when they notice variance. It helps—but it does not eliminate structural variance. All three frontier models in our dataset show nonzero structural variance at temperature zero. Attention routing, batching behavior, and API load conditions introduce variance that temperature doesn't control. Measure empirically. Do not assume.

**[THE BENCHMARK DESIGN — 2:45]**

We created the 10-by-3-by-5 benchmark to measure this precisely. Ten prompt categories. Three frontier models: Opus 4.7, GPT-5.5, and Gemini 3.1 Pro. Five independent runs each, all at temperature zero.

The ten categories represent the full spectrum of tool-use complexity you see in production. Let me walk you through them.

Categories one and two are the simplest. A flat database lookup with two required fields. An action-with-confirmation—three fields, one optional. These are your CRUD operations, your config reads, your basic write-file patterns.

Categories three and four add structured complexity. Extracting five fields from a document. Conditional routing with an enum discriminator—where the model must choose service A or B. These are common in document processing and triage pipelines.

Categories five through seven enter medium complexity. A multi-tool sequence where the model calls two tools in order. A nested object three levels deep with eight total fields. An array of objects with variable length. This is where model differences start to matter.

Categories eight through ten are where pipelines break. A tool with a side-effect warning—the schema includes a boolean confirm field that must be set correctly. Ambiguous input, where the right response might be a tool call *or* a clarifying question. And finally, a multi-model handoff schema—where the output is consumed by a second model, and any structural drift corrupts the next agent in the chain.

One hundred and fifty total runs. Each scored as structural match or mismatch against a canonical reference output. No hand-waving. Raw structural stability.

**[RESULTS — 4:30]**

Here's what the data shows.

On simple schemas—categories one and two—all three models hit near 100%. Model choice on determinism grounds is irrelevant if your use case stays in this zone.

Watch what happens as complexity rises. Opus 4.7 leads overall at 91.4% average. GPT-5.5 follows at 88%. Gemini 3.1 Pro at 79%. But those averages hide the real story.

On nested objects—category six—Opus holds at 88%. Gemini drops to 74%. That's a 14-point gap. On the multi-model handoff schema—category ten—Opus is at 80%, GPT-5.5 at 76%, Gemini at 68%. The complexity tier is the lever. Match your model to your schema complexity, not just your prompt complexity.

Now for the most important single finding in our dataset. GPT-5.5 with strict JSON schema enforcement—enabling the response_format strict parameter—jumps from 88% to 93% on average, and from 82% to 95% on nested schemas specifically. That one API parameter closes the gap to Opus 4.7 entirely on complex categories. Schema enforcement is a bigger lever than model choice for structured-output reliability on OpenAI's platform.

The second important finding is about ambiguous inputs. Category nine—where the correct response might be a tool call or a clarifying question—is the universal weakness. Opus drops to 78%. GPT-5.5 to 74%. Gemini to 64%. All three models fail here more than anywhere else. If your pipeline regularly receives ambiguous inputs, plan for retry logic regardless of which model you choose.

**[FAILURE MODES — 6:15]**

Across 150 runs, we classified every structural mismatch by failure type. The breakdown changes how you think about what to fix.

Key omission accounts for 54% of failures. A required field present in four of five runs is silently absent on the fifth. This is the most dangerous failure mode—not because it's dramatic, but because it's subtle. It passes many JSON schema validators, which check structure but not completeness. Your pipeline receives structurally valid but *incomplete* JSON, and the error surfaces three steps later when something downstream expects a field that isn't there.

Type mismatch—a string where a number should be—accounts for 18%. Extra keys not in the schema: 14%. Nesting depth errors: 9%. Wrong enum value: 5%.

The practical takeaway: most of your debugging time should go toward key omission detection, not schema validation errors. Add explicit required-key presence checks to your output parsers. Don't rely on schema validation alone.

**[RUNNING IT YOURSELF — 7:15]**

The benchmark runner is about 80 lines of Python, built on the Anthropic SDK. The core idea is a structural hash function that extracts the *shape* of the JSON—its keys and types—without the values. Two responses that return different string values for the same keys count as structurally equivalent. Two responses where one has a key the other omits count as mismatches.

You run the prompt five times at temperature zero, compute the structural hash on each response, find the modal hash as your canonical reference, and count how many runs match it. That's your determinism score.

The chapter includes the full script. To run the hands-on exercise, you'll need the Anthropic and OpenAI SDKs, two prompts from your own use case—at least one with four or more required fields—and about 30 minutes.

Run each prompt five times on at least Opus 4.7 and GPT-5.5. Record your scores. Compare them to the reference data for the closest benchmark category. If you see mismatches, use the extract-key-structure function to find which specific keys are varying. That's the actionable signal.

**[INTERPRETATION THRESHOLDS — 8:15]**

Once you have scores, here's how to interpret them.

98 to 100% is near-deterministic. Safe for strict pipelines with no special handling.

90 to 97% is high reliability—acceptable for most production workloads. Add output validation and plan for roughly one retry in ten.

80 to 89% is moderate reliability. Implement schema enforcement first before considering a model switch. Set a retry budget.

70 to 79% is borderline—fragile at scale. Calculate the cost impact of retries before choosing this model for a structured-output use case.

Below 70%: do not use for structured output without constrained generation or output parsers as guardrails.

Apply these thresholds to your *specific prompt categories*, not to the overall average. A model with 95% average determinism may have 70% determinism on the exact prompt type your pipeline uses most. That's why you measure.

**[CLOSING — 9:10]**

So here's the decision framework distilled to three steps.

First: run the benchmark on your actual prompts. Don't guess based on marketing or averaged benchmarks. Five runs, temperature zero, measure the structure.

Second: if GPT-5.5 is in your stack, enable strict JSON schema enforcement before considering any model switch. That single parameter change may give you more reliability improvement than switching models entirely.

Third: if your pipeline has more than three sequential LLM steps, calculate the compounded success rate. 90% per-step sounds good until you see it become 59% across five steps.

Your pipeline's reliability isn't hidden in model names or benchmark leaderboards. It's hidden in empirical data about your specific prompts. And now you have the tool to find it.

In the next chapter, we shift from structural consistency to context fidelity—running a needle-in-a-haystack test across 50K, 200K, and 500K token depths to find out where each model's effective context window actually ends.

---

**[METADATA]**
- Duration: ~580 seconds (9.7 minutes)
- Tempo: 1.0x (normal)
- Voice: Nova (warm tutor, consistent with Academy brand)
- Word count: ~1450
- Notes for synthesis: Conversational pace; pause at section breaks; emphasize the multiplicative math equations verbally ("0.9 to the fifth power"); give the benchmark category descriptions a slightly deliberate, list-like cadence; the "most important single finding" line should carry emphasis; close with energy on the CTA
