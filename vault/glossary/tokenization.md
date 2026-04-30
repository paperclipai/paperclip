---
term: "Tokenization"
definition: "Tokenization is the process of splitting text into discrete units (tokens) that a language model treats as its atomic input — typically subword fragments such that common words are one token and rare words are several, balancing vocabulary size against representation efficiency."
category: "AI architecture"
related_terms: [llm, transformer, embedding, context-window]
related_courses: []
sameAs:
  - https://en.wikipedia.org/wiki/Lexical_analysis#Tokenization
  - https://en.wikipedia.org/wiki/Byte_pair_encoding
---

Modern LLMs use byte-pair encoding (BPE) or its variants — tiktoken (OpenAI), Claude's proprietary tokenizer, and SentencePiece (Google, Meta, Mistral). All three frontier vendor tokenizers produce roughly 3-4 characters per token for English; non-English languages, code, and numerics tokenize less efficiently (often 1-2 characters per token).

Tokenization choices have practical consequences: pricing is per-token, so verbose languages cost more; context windows are measured in tokens; and tokenization boundaries can affect model behavior (the famous SolidGoldMagikarp glitch token in GPT-3 came from a tokenizer artifact).

Tools for inspecting tokenization include OpenAI's tiktoken library, Anthropic's `count_tokens` API endpoint, and Hugging Face's transformers library. Cross-vendor token-count comparisons require running each vendor's tokenizer; there is no universal mapping.
