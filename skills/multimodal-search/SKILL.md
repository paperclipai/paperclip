---
name: multimodal-search
description: >
  Implement multimodal semantic search using Google Gemini Embedding 2.
  Supports embedding and searching across text, images, video, audio, and PDFs
  into a unified vector space. Use when building search features, RAG pipelines,
  or content similarity systems that span multiple modalities.
---

# SKILL: Multimodal Search with Gemini Embedding 2

## Purpose
Build and operate multimodal semantic search systems using Google's Gemini Embedding 2 model,
which natively maps text, images, video, audio, and documents into a single embedding space.

---

## Model Reference

| Property | Value |
|---|---|
| Model ID | `gemini-embedding-2-preview` |
| Text-only model | `gemini-embedding-001` |
| API Endpoint | `https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent` |
| Max dimensions | 3072 (recommended: 768, 1536, 3072) |
| Auth | `GEMINI_API_KEY` env var |

### Input Limits

| Modality | Limit |
|---|---|
| Text tokens | 8,192 |
| Images per request | 6 (PNG, JPEG) |
| Video duration | 120 seconds (MP4, MOV) |
| Audio duration | 80 seconds (MP3, WAV) |
| PDF pages | 6 |

---

## Task Types

Use the appropriate `task_type` to optimize embeddings for your use case:

| Task Type | Use Case |
|---|---|
| `SEMANTIC_SIMILARITY` | Comparing text similarity |
| `CLASSIFICATION` | Categorizing into preset labels |
| `RETRIEVAL_DOCUMENT` | Embedding documents for search index |
| `RETRIEVAL_QUERY` | Embedding search queries |
| `QUESTION_ANSWERING` | QA system retrieval |
| `FACT_VERIFICATION` | Evidence retrieval for fact-checking |

---

## Implementation Patterns

### Text Embedding (Python)

```python
from google import genai
from google.genai import types

client = genai.Client()

result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents="What is the meaning of life?",
    config=types.EmbedContentConfig(
        task_type="SEMANTIC_SIMILARITY",
        output_dimensionality=768,
    ),
)
embedding = result.embeddings[0].values
```

### Image Embedding

```python
with open("photo.png", "rb") as f:
    image_bytes = f.read()

result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents=[types.Part.from_bytes(data=image_bytes, mime_type="image/png")],
)
```

### Video Embedding

```python
with open("clip.mp4", "rb") as f:
    video_bytes = f.read()

result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents=[types.Part.from_bytes(data=video_bytes, mime_type="video/mp4")],
)
```

### Audio Embedding

```python
with open("recording.mp3", "rb") as f:
    audio_bytes = f.read()

result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents=[types.Part.from_bytes(data=audio_bytes, mime_type="audio/mp3")],
)
```

### PDF Embedding

```python
with open("paper.pdf", "rb") as f:
    pdf_bytes = f.read()

result = client.models.embed_content(
    model="gemini-embedding-2-preview",
    contents=[types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf")],
)
```

### Node.js / TypeScript

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Text embedding
const result = await ai.models.embedContent({
  model: "gemini-embedding-2-preview",
  contents: "Search query text",
  config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 },
});

// Image embedding
const imageBuffer = fs.readFileSync("photo.png");
const result = await ai.models.embedContent({
  model: "gemini-embedding-2-preview",
  contents: [{ inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/png" } }],
});
```

---

## Normalization

The 3072-dimension output is pre-normalized. For reduced dimensions (768, 1536),
normalize manually:

```python
import numpy as np

embedding = np.array(result.embeddings[0].values)
normalized = embedding / np.linalg.norm(embedding)
```

---

## Architecture Pattern: Multimodal RAG

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────┐
│  Documents   │     │  Gemini Embedding   │     │  Vector DB   │
│  Images      │────▶│  2 Preview          │────▶│  (ChromaDB,  │
│  Audio/Video │     │  Unified Space      │     │   Qdrant,    │
│  PDFs        │     └────────────────────┘     │   Pinecone)  │
└──────────────┘                                 └──────┬───────┘
                                                        │
┌──────────────┐     ┌────────────────────┐            │
│  User Query  │────▶│  Embed Query       │────────────┘
│  (any mode)  │     │  (same model)      │     cosine similarity
└──────────────┘     └────────────────────┘     → top-k results
```

---

## Vector Database Integration

Supported backends: ChromaDB, Qdrant, Weaviate, Pinecone, Vertex AI Vector Search, BigQuery.

### ChromaDB Example

```python
import chromadb

client = chromadb.Client()
collection = client.create_collection("multimodal_docs", metadata={"hnsw:space": "cosine"})

# Index documents
for doc_id, embedding, metadata in documents:
    collection.add(ids=[doc_id], embeddings=[embedding], metadatas=[metadata])

# Query
results = collection.query(query_embeddings=[query_embedding], n_results=10)
```

---

## Critical Notes

- **Incompatible spaces**: `gemini-embedding-001` and `gemini-embedding-2-preview` produce incompatible embeddings. Never mix them — re-embed all data when switching models.
- **Batch API**: For bulk indexing, use the Batch API for 50% cost reduction (higher throughput, higher latency).
- **Cross-modal search**: A text query can find relevant images/videos/audio and vice versa — all modalities share the same vector space.

---

## When to Use This Skill

- Building semantic search across documents, images, and media
- Creating RAG (Retrieval-Augmented Generation) pipelines
- Content deduplication across modalities
- Building recommendation systems
- Academic paper search with figures and supplementary materials
- Media asset management and discovery
