---
term: "Retrieval-Augmented Generation (RAG)"
definition: "Retrieval-Augmented Generation (RAG) is a technique introduced by Meta AI in 2020 for grounding large language model outputs in retrieved external documents, combining a retriever (typically a vector index) with a generator (a language model) so the model's response is conditioned on relevant source material rather than parametric memory alone."
category: "AI architecture"
related_terms: [embedding, vector-database, agent-harness, mcp]
related_courses: []
sameAs:
  - https://en.wikipedia.org/wiki/Retrieval-augmented_generation
  - https://arxiv.org/abs/2005.11401
---

RAG addresses three weaknesses of pure parametric LLMs: factual staleness, hallucination on niche topics, and citation traceability. A typical pipeline embeds documents into a vector index at ingest time, embeds the user query at request time, retrieves the top-k semantically similar documents, and prepends them to the model prompt as context.

Common implementation choices include: dense retrieval (e.g., text-embedding-004, Voyage-3) versus sparse retrieval (BM25); reranking with a cross-encoder; chunking strategy (fixed-size vs. semantic); and the prompt template that integrates retrieved context.

Modern RAG variants include agentic RAG (the model can re-query iteratively), graph-RAG (retrieving connected sub-graphs from a knowledge graph), and hybrid retrieval (dense + sparse with score fusion). MCP increasingly replaces ad-hoc RAG plumbing for agent-style applications.
