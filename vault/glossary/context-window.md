---
term: "Context window"
definition: "The context window is the maximum number of tokens a large language model can process in a single forward pass, including the prompt, all in-context examples, retrieved documents, and the model's generated output — measured in thousands or millions of tokens."
category: "inference"
related_terms: [tokenization, llm, transformer]
related_courses: [picking-a-frontier-model-2026-q2]
sameAs:
  - https://en.wikipedia.org/wiki/Context_window
---

Frontier model context windows as of April 2026: Anthropic Claude Sonnet 4.6 / Opus 4.7 — 1M tokens (with extended-context variants); OpenAI GPT-5.5 — 1M tokens; Google Gemini 3.1 Pro — 2M tokens. Open-weights models typically range 8K-128K, with some long-context variants reaching 1M+.

Context-window size matters less than effective context — how reliably the model uses information at different positions. The "lost in the middle" phenomenon (Liu et al., 2023) shows that models systematically attend more to context at the start and end of the window than the middle, even with stated 1M context. Anthropic's needle-in-a-haystack and Google's MRCR benchmarks measure this.

Practical implications for builders: pay-as-you-go pricing scales linearly or super-linearly with input tokens; KV cache memory dominates inference latency at long context; and prompt-caching APIs (Anthropic, OpenAI, Google) offer 50-90% cost reduction for repeated long prompts.
