---
term: "Large Language Model (LLM)"
definition: "A Large Language Model (LLM) is a deep neural network — typically a transformer with billions to trillions of parameters — trained on large text corpora to predict the next token, then fine-tuned for instruction-following, dialogue, and increasingly tool use and reasoning."
seo_description: "Large Language Model (LLM) explained: what they are, how they work, and why they matter for building AI applications."
category: "AI architecture"
related_terms: [transformer, tokenization, embedding, fine-tuning, rlhf]
related_courses: [picking-a-frontier-model-2026-q2]
sameAs:
  - https://en.wikipedia.org/wiki/Large_language_model
  - https://www.wikidata.org/wiki/Q115305900
---

The frontier LLMs as of April 2026 are Anthropic Claude Opus 4.7, OpenAI GPT-5.5, and Google Gemini 3.1 Pro. All three are decoder-only transformers; all three offer tool use, long context (200K to 1M+ tokens), and image input; none publish parameter counts, but inference behavior suggests trillions for the top tier.

Open-weights leaders include Meta Llama 4, Google Gemma 4 (April 2026), Qwen 3.5, and Mistral Large 2. Open-weights models lag the frontier on raw intelligence by roughly 6-12 months but lead on deployment flexibility (single-GPU inference, edge deployment, on-premise compliance).

Practical model selection depends on three axes: intelligence (frontier vs open-weights), cost-per-task (varies 10-100×), and deployment shape (cloud API, self-hosted, on-device). Koenig AI Academy publishes an updated frontier-model comparison at /data/claude-tool-use-determinism/.
