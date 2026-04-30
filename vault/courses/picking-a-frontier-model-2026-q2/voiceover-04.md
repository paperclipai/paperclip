---
chapter: 4
chapter_slug: cost-per-task
title: "Voiceover script — Cost-per-task"
type: voiceover-script
voice_preset: nova-warm
target_duration_sec: 180
word_count: 450
---

# Voiceover script — Cost-per-task: Pricing vs. actual bill on real workloads

**[Intro — set the trap]**

You've probably seen the pricing comparison: Claude Opus is fifteen dollars per million input tokens. GPT-5.5 is ten dollars. Gemini is three-fifty. That makes Gemini four times cheaper, right?

Wrong.

This chapter reveals why that comparison is almost useless for production cost planning — and shows you the break-even point where the cheapest-per-token model becomes the most expensive per completed task.

**[The hidden factor: retries]**

Here's what the pricing tables omit: retry rate. Every time your model produces a malformed output or makes a mistake, you run the entire prompt again. Your bill climbs. For agentic systems with long pipelines — think coding agents, planning systems, anything with five or more decision steps — this compounds fast.

Let's do the math. Say you have a three-step tool-use pipeline. Opus 4.7 determinism on that task type is 94 percent. That means 94 percent of the time, each step succeeds. String three steps together, and your pipeline succeeds 0.94 to the third power — about 83 percent of the time. The other 17 percent requires a retry.

Gemini 3.1 Pro, at the same three-step task, has determinism of 84 percent. That's a ten-point gap. In isolation, small. But at three steps, it means your pipeline succeeds only 59 percent of the time.

You need 1.2 runs of Opus to complete one successful task. You need 1.69 runs of Gemini.

When you factor that retry amplification into the cost model, Gemini's cost advantage compresses from four times cheaper to three-point-six times cheaper. Still cheaper — but the gap is closing.

Now stretch that to a ten-step pipeline. The retry multiplier scales exponentially: one over determinism to the power of n. A fourteen-point determinism gap — Opus at 78 percent, Gemini at 64 percent — produces a seven-point-two times difference in expected runs to success.

**[The inversion]**

Here's where it gets truly contrarian. At ten steps with ambiguous input, Opus costs about twelve dollars per successful task. Gemini costs about eighteen dollars.

The model with the lowest per-token price now costs fifty percent more to actually complete the work.

This break-even occurs around eight to nine steps. If your agentic system has eight or more action steps on difficult inputs — and most production coding agents do — the pricing page is actively misleading you.

**[The lever you can control]**

One more factor: prompt caching. If you cache your ten-thousand-token system prompt, Anthropic charges you ninety percent less on cached tokens. That nearly closes the gap between Opus and Gemini on high-volume, repetitive workloads.

**[Closing]**

The lesson: don't pick your model based on $/M token. Build a cost-per-task model using your own determinism scores and pipeline length. Measure, calculate, and then decide. That's how you avoid paying the wrong model's tax at scale.

---

**Production notes:**
- Duration target: 180 sec (3 min) at normal speech rate (~150 wpm)
- Tone: conversational, slightly provocative (the contrarian angle)
- Emphasis: retry multiplier, the break-even point, prompt caching as a closing lever
- Pauses: after "wrong," after "more expensive per completed task," and before "the lesson"
