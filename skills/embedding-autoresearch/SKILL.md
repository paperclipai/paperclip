---
name: embedding-autoresearch
description: >
  Portable skill that combines Gemini Embedding 2 multimodal search with
  Karpathy's AutoResearch autonomous experiment loop. Drop into any project
  to continuously optimize embedding pipelines (chunking, dimensions, task
  types, preprocessing, reranking) against a measurable retrieval metric.
  Works with text, images, video, audio, and PDFs.
---

# SKILL: Embedding AutoResearch

## Purpose

Autonomous, metric-driven optimization of multimodal embedding pipelines.
Drop this skill into any project that uses vector search or RAG and let the
agent run hundreds of experiments to find the best configuration — while you
sleep.

Combines:
- **Gemini Embedding 2** — natively multimodal embeddings (text, image, video, audio, PDF)
- **AutoResearch** — Karpathy's autonomous experiment loop (single file, single metric, git-tracked)

---

## When to Use This Skill

- You have a retrieval / search / RAG system and want to improve recall or precision
- You can measure "better" with a number (MRR, NDCG, recall@k, latency, cost)
- You want the agent to explore configurations autonomously
- You want results tracked in git with full experiment history

---

## The 3-File Setup

Create these three files in your project:

### 1. `program.md` — The Agent Brain

Tells the agent what to optimize and how to loop. **Template below — adapt the
objective to your domain.**

### 2. `embedding_config.py` (or `.ts` / `.json`) — The Editable File

The ONLY file the agent modifies. Contains all tunable parameters:

```python
# embedding_config.py — THE AGENT EDITS THIS FILE ONLY

CONFIG = {
    # Model
    "model": "gemini-embedding-2-preview",
    "dimensions": 768,            # try: 128, 256, 512, 768, 1536, 3072
    "task_type": "RETRIEVAL_DOCUMENT",  # try: SEMANTIC_SIMILARITY, CLASSIFICATION, QUESTION_ANSWERING

    # Chunking
    "chunk_strategy": "fixed",    # try: fixed, sentence, paragraph, semantic, sliding_window
    "chunk_size": 512,            # tokens per chunk
    "chunk_overlap": 64,          # overlap between chunks

    # Preprocessing
    "strip_html": True,
    "lowercase": False,
    "remove_stopwords": False,
    "expand_acronyms": False,

    # Query
    "query_task_type": "RETRIEVAL_QUERY",
    "query_prefix": "",           # try: "search_query: ", "query: "
    "doc_prefix": "",             # try: "search_document: ", "passage: "

    # Retrieval
    "top_k": 10,
    "similarity_metric": "cosine",  # cosine, dot, euclidean
    "rerank": False,
    "rerank_model": None,

    # Multimodal
    "embed_images": True,
    "embed_tables_as_text": True,
    "image_max_size": 1024,       # resize before embedding
    "pdf_extract_images": False,
}
```

### 3. `eval_retrieval.py` — The Evaluation Script (NEVER edited by agent)

Measures retrieval quality. The agent runs this after every experiment.

```python
"""
Evaluation script — DO NOT MODIFY.
Loads embedding_config.py, builds index, runs eval queries, reports metrics.
"""
import json, sys, time, importlib, numpy as np
from datetime import datetime

def load_config():
    spec = importlib.util.spec_from_file_location("cfg", "embedding_config.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.CONFIG

def embed_content(client, content, config, task_type=None):
    """Embed any content using Gemini Embedding 2."""
    from google.genai import types
    result = client.models.embed_content(
        model=config["model"],
        contents=content,
        config=types.EmbedContentConfig(
            task_type=task_type or config["task_type"],
            output_dimensionality=config["dimensions"],
        ),
    )
    vec = np.array(result.embeddings[0].values)
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 0 else vec

def cosine_sim(a, b):
    return np.dot(a, b)

def evaluate(config):
    from google import genai

    client = genai.Client()

    # --- Load your eval dataset here ---
    # eval_data = json.load(open("eval_dataset.json"))
    # Each entry: { "query": "...", "relevant_ids": ["doc1", "doc2"], "corpus": [...] }
    # Adapt this section to YOUR data.
    eval_data = json.load(open("eval_dataset.json"))

    metrics = {"mrr": [], "recall_at_k": [], "latency_ms": []}

    for entry in eval_data:
        # Embed corpus
        t0 = time.time()
        doc_prefix = config.get("doc_prefix", "")
        corpus_vecs = []
        for doc in entry["corpus"]:
            content = doc_prefix + doc["text"] if isinstance(doc, dict) else doc_prefix + doc
            vec = embed_content(client, content, config, config["task_type"])
            corpus_vecs.append(vec)

        # Embed query
        q_prefix = config.get("query_prefix", "")
        q_vec = embed_content(
            client, q_prefix + entry["query"], config,
            config.get("query_task_type", "RETRIEVAL_QUERY"),
        )
        latency = (time.time() - t0) * 1000

        # Rank
        scores = [cosine_sim(q_vec, dv) for dv in corpus_vecs]
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        top_ids = [entry["corpus"][i]["id"] if isinstance(entry["corpus"][i], dict)
                   else str(i) for i in ranked[:config["top_k"]]]
        relevant = set(entry["relevant_ids"])

        # MRR
        mrr = 0.0
        for rank, doc_id in enumerate(top_ids, 1):
            if doc_id in relevant:
                mrr = 1.0 / rank
                break
        metrics["mrr"].append(mrr)

        # Recall@k
        found = len(set(top_ids) & relevant)
        metrics["recall_at_k"].append(found / len(relevant) if relevant else 0)
        metrics["latency_ms"].append(latency)

    result = {
        "mrr": round(np.mean(metrics["mrr"]), 4),
        "recall_at_k": round(np.mean(metrics["recall_at_k"]), 4),
        "avg_latency_ms": round(np.mean(metrics["latency_ms"]), 1),
        "dimensions": config["dimensions"],
        "chunk_strategy": config["chunk_strategy"],
        "chunk_size": config["chunk_size"],
        "task_type": config["task_type"],
        "timestamp": datetime.now().isoformat(),
    }

    # Primary score: MRR (higher is better)
    score = result["mrr"]

    # Log to TSV
    with open("results.tsv", "a") as f:
        f.write("\t".join(str(v) for v in result.values()) + "\n")

    print(f"SCORE: {score}")
    print(json.dumps(result, indent=2))
    return score

if __name__ == "__main__":
    config = load_config()
    score = evaluate(config)
    sys.exit(0)
```

---

## program.md Template

Copy this into your project and adapt the objective line:

```markdown
# Embedding AutoResearch Program

## Objective
Maximize MRR (Mean Reciprocal Rank) for the retrieval pipeline defined in
eval_retrieval.py. Higher is better. Target: >0.85

## Architecture
- `embedding_config.py` — the ONLY file you may edit
- `eval_retrieval.py` — the evaluation script. NEVER modify this file.
- `program.md` — this file. NEVER modify.

## Rules
1. You may ONLY modify `embedding_config.py`
2. You may NEVER modify `eval_retrieval.py` or `program.md`
3. After each change, run: `python eval_retrieval.py`
4. If SCORE improves over the best so far:
   - `git add embedding_config.py results.tsv`
   - `git commit -m "experiment: [what you changed] mrr=[score]"`
5. If SCORE does not improve:
   - `git checkout -- embedding_config.py`
   - Try a different hypothesis
6. Never stop. Never ask for confirmation. Keep experimenting.

## Experiment Strategy (suggested order)

### Phase 1: Dimensions
Try dimensions in order: 768, 1536, 3072, 512, 256, 128
Keep the best and move on.

### Phase 2: Task Types
Try: RETRIEVAL_DOCUMENT, SEMANTIC_SIMILARITY, QUESTION_ANSWERING, CLASSIFICATION
Test with both matching and mismatched query/doc task types.

### Phase 3: Chunking
Try strategies: fixed, sentence, paragraph, sliding_window
For each, try chunk sizes: 256, 512, 1024, 2048
Try overlaps: 0, 32, 64, 128

### Phase 4: Preprocessing
Toggle: strip_html, lowercase, remove_stopwords, expand_acronyms
Test prefix strings: "", "search_document: ", "passage: "

### Phase 5: Combinations
Combine the best from each phase. Try novel combinations.

## Logging
After each experiment, whether successful or not, write a one-line note
to experiment_log.md with: hypothesis, change made, result, keep/revert.
```

---

## Quick Start (any project)

```bash
# 1. Copy skill files into your project
cp -r skills/embedding-autoresearch/templates/ my-project/
cd my-project && git init

# 2. Create your eval dataset
cat > eval_dataset.json << 'JSON'
[
  {
    "query": "How does photosynthesis work?",
    "relevant_ids": ["doc_3", "doc_7"],
    "corpus": [
      {"id": "doc_1", "text": "The water cycle involves evaporation..."},
      {"id": "doc_3", "text": "Photosynthesis converts light energy into chemical energy..."},
      {"id": "doc_7", "text": "Plants use chlorophyll to absorb sunlight for photosynthesis..."}
    ]
  }
]
JSON

# 3. Install dependencies
pip install google-genai numpy

# 4. Set API key
export GEMINI_API_KEY="your-key"

# 5. Run baseline
python eval_retrieval.py

# 6. Launch autonomous loop
claude --dangerously-skip-permissions
# Then: "Read program.md. Run baseline. Start experiment loop. Don't stop."
```

---

## Portable Across Projects

This skill is domain-agnostic. Adapt it to:

| Project Type | Eval Dataset | What Gets Optimized |
|---|---|---|
| **Academic paper search** | query + relevant papers | chunk size, dimensions, PDF image extraction |
| **E-commerce product search** | search queries + clicked products | task type, prefixes, multimodal (product images) |
| **Legal document retrieval** | legal questions + relevant clauses | chunk strategy, overlap, dimensions |
| **Codebase search** | code queries + relevant files | preprocessing, chunk boundaries |
| **Media asset search** | text descriptions + matching images/videos | image resize, video duration, dimensions |
| **Customer support** | support tickets + resolution docs | query prefix, reranking, task type |
| **Medical literature** | clinical questions + evidence docs | chunk strategy, acronym expansion |

---

## Paperclip Integration

Assign to any agent as an AutoResearch optimizer:

```json
{
  "model": "claude-sonnet-4-6",
  "cwd": "/path/to/your/search-project",
  "instructionsFilePath": "/path/to/your/search-project/program.md",
  "dangerouslySkipPermissions": true,
  "maxTurnsPerRun": 50,
  "env": {
    "GEMINI_API_KEY": "{{secret:gemini_api_key}}"
  }
}
```

---

## Multimodal Embedding Reference

### Supported Inputs (Gemini Embedding 2)

| Modality | Limit | Formats |
|---|---|---|
| Text | 8,192 tokens | plain text |
| Images | 6 per request | PNG, JPEG |
| Video | 120 seconds | MP4, MOV |
| Audio | 80 seconds | MP3, WAV |
| PDF | 6 pages | PDF |

### Embedding Code Patterns

```python
from google import genai
from google.genai import types

client = genai.Client()

# Text
result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents="your text here",
    config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", output_dimensionality=768),
)

# Image
result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents=[types.Part.from_bytes(data=open("img.png","rb").read(), mime_type="image/png")],
)

# Video
result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents=[types.Part.from_bytes(data=open("clip.mp4","rb").read(), mime_type="video/mp4")],
)
```

### Normalization (required for dimensions < 3072)

```python
import numpy as np
vec = np.array(result.embeddings[0].values)
normalized = vec / np.linalg.norm(vec)
```

---

## What the Agent Explores

The experiment loop systematically tests combinations of:

1. **Embedding dimensions**: 128 → 3072 (cost vs quality tradeoff)
2. **Task types**: RETRIEVAL_DOCUMENT, SEMANTIC_SIMILARITY, QUESTION_ANSWERING
3. **Chunking**: fixed, sentence, paragraph, sliding window + size + overlap
4. **Preprocessing**: HTML stripping, lowercasing, stopword removal, acronym expansion
5. **Query/doc prefixes**: "search_query: ", "passage: ", custom
6. **Multimodal toggles**: embed images, extract tables, PDF image extraction
7. **Similarity metrics**: cosine, dot product, euclidean
8. **Top-k values**: retrieval depth tuning

Every improvement is git-committed. Every failure is reverted. You get a full
experiment history in `results.tsv` and `experiment_log.md`.
