---
chapter: 3
chapter_slug: long-context-behavior
title: "Voiceover script — Ch3: Long-context behavior"
status: ready-for-production
type: voiceover-script
word_count: 425
target_duration_sec: 85
voice_preset: "nova-warm"
date: 2026-04-30
---

# Voiceover: Ch3 — Long-context behavior

Here's the uncomfortable truth: a one-million-token context window is not the same as a one-million-token working memory.

Google Gemini advertises one million tokens. Anthropic Claude advertises two hundred thousand. OpenAI GPT advertises a hundred and twenty-eight thousand. These numbers look like a straightforward ranking: bigger is better. They're not.

What vendors don't advertise is the shape of the accuracy curve. As you fill the context window, retrieval gets worse. Reasoning gets worse. Somewhere inside that large number is a much smaller number — the *effective* context limit — where the model stops being reliable.

For Gemini, single-fact retrieval stays accurate up to about 700K tokens. Impressive. But multi-fact reasoning — the kind where you're synthesizing insights across three or four different parts of your document — that degrades above 300K. That's 30 percent of the advertised window. For Claude Opus, synthesis drops below 85 percent accuracy around 120K tokens. The advertised window is 200K.

This matters because synthesis is what you actually need. It's why you load documents in the first place.

There's a pattern to how models fail at scale. First: lost needles. A fact is right there in the document, but the model doesn't retrieve it. It just... doesn't see it. Second: hallucinated synthesis. The model invents connections between facts that aren't there. And third: degraded reasoning. The model takes shortcuts. It skips steps that it would normally work through.

All three show up reliably once you exceed the effective limit.

So here's the contrarian move: if you have a large document set — say, 200K tokens — don't load it all at once. Instead, use a retrieval-augmented generation pipeline. Chunk your documents. Embed them. Retrieve the top five relevant chunks. Let Claude Opus synthesize those five chunks.

The numbers: a RAG pipeline on the same 200K-token corpus costs ten times less and achieves *higher* synthesis accuracy than loading the full context. Not lower. Higher. You get better results faster and cheaper.

The rule of thumb: use long context for retrieval tasks, when you need a single fact and you want to be absolutely sure the model sees it. Use chunking and retrieval for synthesis — for reasoning across your documents. These are different operations with different reliability profiles.

By the end of this chapter, you'll have the tools to measure where your own models break. You'll run needle-in-haystack tests at three different document depths. You'll find your effective limit. And you'll make a choice: load full context, or architect a smarter retrieval pipeline.

That choice is where the real gains come from.
