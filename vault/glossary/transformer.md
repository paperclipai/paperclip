---
term: "Transformer"
definition: "The Transformer is a neural network architecture introduced by Vaswani et al. in 2017 that uses self-attention to process sequences in parallel, replacing the recurrence of RNNs and LSTMs and becoming the foundational architecture for nearly every modern large language model."
category: "AI architecture"
related_terms: [llm, embedding, tokenization]
related_courses: []
sameAs:
  - https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)
  - https://www.wikidata.org/wiki/Q85810444
  - https://arxiv.org/abs/1706.03762
---

The seminal paper "Attention Is All You Need" introduced two transformer variants: the encoder-decoder used for translation, and the decoder-only used for language modeling. Modern frontier LLMs (Claude, GPT, Gemini) are all decoder-only transformers with multi-head causal self-attention.

Key architectural elements: self-attention (each token attends to all previous tokens), multi-head attention (parallel attention computations with different learned projections), positional encoding (since transformers have no inherent sequence order), and feed-forward layers between attention blocks. Modern variants include sparse mixture-of-experts (MoE) like Mixtral and the Switch Transformer, and rotary positional embeddings (RoPE) which now dominate over absolute positional encodings.

The transformer's training compute cost scales quadratically with sequence length due to the attention matrix; long-context techniques like FlashAttention, sliding-window attention, and ring attention address this in different ways.
