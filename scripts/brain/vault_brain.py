"""
vault_brain.py — Hybrid retrieval engine for the Obsidian second brain.

Architecture (per current SOTA):
  - Episodic memory   = 07 - Ingested/    (raw events, append-only, bi-temporal)
  - Semantic memory   = 08 - Semantic/    (extracted facts, Mem0-style)
  - Procedural memory = 02 - Operations/  (runbooks, curated)
  - Curated memory    = 01/03/04/06       (decisions, topology, protocol)

Retrieval = hybrid BM25 (sparse) + nomic-embed-text v1.5 (dense, 768d, local
via LM Studio) fused with Reciprocal Rank Fusion (RRF, k=60). Index lives in
one SQLite file with FTS5 + a vec(768) BLOB column.

Citations:
  - Tulving (1972) — episodic vs semantic vs procedural memory taxonomy
  - Cormack, Clarke, Buettcher (2009) — Reciprocal Rank Fusion (default k=60)
  - Lin et al. (2024) — RRF beats BM25 / dense alone on MS MARCO
  - Nussbaum et al. (2024) — nomic-embed-text-v1.5, 768d, MTEB SOTA at size
  - Chhikara et al. (2025) — Mem0: append-only single-pass extraction (arXiv:2504.19413)
  - Packer et al. (2024) — MemGPT/Letta hierarchical memory (arXiv:2310.08560)
  - Gutierrez et al. (2024) — HippoRAG: PageRank-style traversal (arXiv:2405.14831)

Usage:
  python vault_brain.py index                    # full reindex
  python vault_brain.py index --incremental      # only changed files
  python vault_brain.py query "how is Atlas configured" --k 10
  python vault_brain.py query "..." --format json
  python vault_brain.py stats                    # index stats
"""
try:
    from lmstudio_response import extract_lmstudio_content
except Exception:
    from scripts.brain.lmstudio_response import extract_lmstudio_content
try:
    from lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
except Exception:
    from scripts.brain.lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import struct
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

# Force stdout to UTF-8 on Windows so non-ASCII chars in vault content don't crash printing
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ─── Configuration ────────────────────────────────────────────────────────────
VAULT_PATH = Path(os.environ.get("VAULT_PATH", r"C:\Users\Smedj\Documents\Obsidian Vault"))
INDEX_PATH = VAULT_PATH / ".vault-brain.sqlite"
EMBED_URL = get_lmstudio_config()["base_url"] + "/v1/embeddings"
EMBED_MODEL = os.environ.get("EMBED_MODEL", get_lmstudio_config()["embed_model"])
EMBED_DIM = 768  # nomic-embed-text-v1.5

# Chunking: target ~500 tokens, overlap 50. Tokens approximated as 4 chars.
CHUNK_TARGET_CHARS = 2000
CHUNK_OVERLAP_CHARS = 200

# Reciprocal Rank Fusion constant. k=60 from Cormack et al. 2009 — the canonical default.
RRF_K = 60

# Folders to exclude from indexing (binary, daemon state, .obsidian internals)
EXCLUDED_DIRS = {".obsidian", ".trash", ".vault-brain.sqlite"}
EXCLUDED_FILES = {".vault-ingest-state.json"}


@dataclass
class Chunk:
    file_path: str           # vault-relative
    chunk_idx: int
    text: str
    sha: str
    folder: str              # top-level folder, e.g. "07 - Ingested"
    source: str              # derived: "episodic" | "semantic" | "procedural" | "curated"
    tags: list[str]
    event_at: str | None     # ISO from frontmatter if present


# ─── Embedding client (LM Studio, nomic-embed-text-v1.5) ──────────────────────
def embed_batch(texts: list[str], retries: int = 3) -> list[list[float]]:
    """Call LM Studio /v1/embeddings. Single request per call (LM Studio supports batches)."""
    payload = json.dumps({"model": EMBED_MODEL, "input": texts}).encode("utf-8")
    req = urllib.request.Request(EMBED_URL, data=payload, headers={"Content-Type": "application/json"})
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read().decode("utf-8"))
            return [item["embedding"] for item in d["data"]]
        except Exception as e:
            last_err = e
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"embed_batch failed after {retries} retries: {last_err}")


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def pack_vec(v: list[float]) -> bytes:
    return struct.pack(f"{len(v)}f", *v)


def unpack_vec(b: bytes) -> list[float]:
    n = len(b) // 4
    return list(struct.unpack(f"{n}f", b))


# ─── Frontmatter & chunking ──────────────────────────────────────────────────
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_block = m.group(1)
    body = text[m.end() :]
    fm = {}
    for line in fm_block.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        v = v.strip()
        # Crude YAML — handles "key: \"val\"", "key: [a, b, c]", "key: val"
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1].replace('\\"', '"')
        elif v.startswith("[") and v.endswith("]"):
            inner = v[1:-1]
            v = [item.strip().strip('"') for item in inner.split(",") if item.strip()]
        fm[k.strip()] = v
    return fm, body


def folder_to_source(folder: str) -> str:
    """Map vault top-level folder to memory category."""
    if folder.startswith("07 - Ingested"):
        return "episodic"
    if folder.startswith("08 - Semantic"):
        return "semantic"
    if folder.startswith("02 - Operations"):
        return "procedural"
    return "curated"


def chunk_text(text: str) -> list[str]:
    """Char-based chunker with overlap. Cheap and robust for markdown."""
    if len(text) <= CHUNK_TARGET_CHARS:
        return [text] if text.strip() else []
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_TARGET_CHARS, len(text))
        # Prefer to break at paragraph
        if end < len(text):
            break_at = text.rfind("\n\n", start, end)
            if break_at > start + CHUNK_TARGET_CHARS // 2:
                end = break_at
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = end - CHUNK_OVERLAP_CHARS
    return [c for c in chunks if c]


def iter_vault_chunks() -> Iterable[Chunk]:
    """Walk the vault, yield chunks with metadata."""
    for root, dirs, files in os.walk(VAULT_PATH):
        # Prune excluded dirs in-place
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        for fname in files:
            if not fname.endswith(".md"):
                continue
            if fname in EXCLUDED_FILES:
                continue
            fpath = Path(root) / fname
            rel = fpath.relative_to(VAULT_PATH).as_posix()
            top_folder = rel.split("/", 1)[0]
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            fm, body = parse_frontmatter(text)
            tags = fm.get("tags", []) if isinstance(fm.get("tags"), list) else []
            event_at = fm.get("event_at") or fm.get("created") or None
            source = folder_to_source(top_folder)
            for i, chunk in enumerate(chunk_text(body)):
                sha = hashlib.sha256(f"{rel}::{i}::{chunk}".encode("utf-8")).hexdigest()[:16]
                yield Chunk(rel, i, chunk, sha, top_folder, source, tags, event_at)


# ─── Index lifecycle ──────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    sha TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL,
    source TEXT NOT NULL,
    tags TEXT,                 -- JSON array
    event_at TEXT,
    text TEXT NOT NULL,
    embedding BLOB             -- 768f packed; NULL if not yet embedded
);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_folder ON chunks(folder);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    file_path UNINDEXED,
    folder UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def open_index() -> sqlite3.Connection:
    conn = sqlite3.connect(INDEX_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def cmd_index(args):
    full = not args.incremental
    conn = open_index()
    cur = conn.cursor()
    t0 = time.time()

    if full:
        cur.execute("DELETE FROM chunks")
        cur.execute("DELETE FROM chunks_fts")
        conn.commit()

    # Collect all current SHAs
    new_chunks: list[Chunk] = []
    seen_shas: set[str] = set()
    for ch in iter_vault_chunks():
        seen_shas.add(ch.sha)
        new_chunks.append(ch)

    if args.incremental:
        existing = {row[0] for row in cur.execute("SELECT sha FROM chunks").fetchall()}
        # Delete chunks no longer present
        to_delete = existing - seen_shas
        if to_delete:
            placeholders = ",".join("?" * len(to_delete))
            cur.execute(f"DELETE FROM chunks WHERE sha IN ({placeholders})", list(to_delete))
            cur.execute(f"DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE sha IN ({placeholders}))", list(to_delete))
        # Filter to only new chunks
        new_chunks = [c for c in new_chunks if c.sha not in existing]

    print(f"[index] {len(new_chunks)} new chunk(s) to embed (full={full})")
    inserted = 0
    BATCH = 32  # LM Studio handles ~32-64 inputs cleanly
    for i in range(0, len(new_chunks), BATCH):
        batch = new_chunks[i : i + BATCH]
        try:
            embeddings = embed_batch([c.text[:8000] for c in batch])  # truncate to 8K chars per chunk for safety
        except Exception as e:
            print(f"[index] WARN: embed batch failed at {i}: {e}", file=sys.stderr)
            embeddings = [None] * len(batch)
        for c, emb in zip(batch, embeddings):
            blob = pack_vec(emb) if emb else None
            try:
                cur.execute(
                    "INSERT OR IGNORE INTO chunks (file_path, chunk_idx, sha, folder, source, tags, event_at, text, embedding) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (c.file_path, c.chunk_idx, c.sha, c.folder, c.source, json.dumps(c.tags), c.event_at, c.text, blob),
                )
                rowid = cur.lastrowid
                cur.execute(
                    "INSERT INTO chunks_fts (rowid, text, file_path, folder) VALUES (?, ?, ?, ?)",
                    (rowid, c.text, c.file_path, c.folder),
                )
                inserted += 1
            except Exception as e:
                print(f"[index] WARN: insert failed for {c.file_path}#{c.chunk_idx}: {e}", file=sys.stderr)
        if i and i % (BATCH * 10) == 0:
            conn.commit()
            print(f"[index] {inserted}/{len(new_chunks)} indexed (elapsed {time.time()-t0:.1f}s)")

    cur.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_index_at', ?)", (str(int(time.time())),))
    conn.commit()
    print(f"[index] done. {inserted} chunk(s) added in {time.time()-t0:.1f}s")
    cmd_stats(args)


def cmd_stats(args):
    conn = open_index()
    cur = conn.cursor()
    rows = cur.execute("SELECT source, COUNT(*) FROM chunks GROUP BY source").fetchall()
    total = cur.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    embedded = cur.execute("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL").fetchone()[0]
    distinct_files = cur.execute("SELECT COUNT(DISTINCT file_path) FROM chunks").fetchone()[0]
    last = cur.execute("SELECT value FROM meta WHERE key='last_index_at'").fetchone()
    print(f"\n=== Vault Brain Index ===")
    print(f"  files indexed:   {distinct_files}")
    print(f"  total chunks:    {total}")
    print(f"  with embeddings: {embedded} ({100*embedded/max(total,1):.1f}%)")
    print(f"  by source:")
    for s, n in rows:
        print(f"    {s:12} {n}")
    if last:
        from datetime import datetime
        print(f"  last index:      {datetime.fromtimestamp(int(last[0])).isoformat()}")


# ─── Retrieval ────────────────────────────────────────────────────────────────
def fts_query_escape(query: str) -> str:
    """FTS5 MATCH expects safe tokens. Strip control chars, quote each word."""
    words = re.findall(r"\w+", query, flags=re.UNICODE)
    if not words:
        return '""'
    # OR all tokens, prefix-match the last for query continuation
    return " OR ".join(f'"{w}"*' for w in words)


def search_bm25(conn: sqlite3.Connection, query: str, k: int) -> list[tuple[int, float]]:
    """Return list of (rowid, bm25_score) for top-k matches. Lower score = better in bm25()."""
    fts = fts_query_escape(query)
    rows = conn.execute(
        "SELECT rowid, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?",
        (fts, k),
    ).fetchall()
    return [(rid, sc) for rid, sc in rows]


def search_dense(conn: sqlite3.Connection, query_vec: list[float], k: int, source_filter: str | None = None) -> list[tuple[int, float]]:
    """Return list of (rowid, cosine) for top-k by cosine similarity."""
    sql = "SELECT rowid, embedding FROM chunks WHERE embedding IS NOT NULL"
    params: list = []
    if source_filter:
        sql += " AND source = ?"
        params.append(source_filter)
    rows = conn.execute(sql, params).fetchall()
    scored = []
    for rid, blob in rows:
        v = unpack_vec(blob)
        scored.append((rid, cosine(query_vec, v)))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]


def rrf_fuse(rankings: list[list[tuple[int, float]]], k: int = RRF_K) -> dict[int, float]:
    """Reciprocal Rank Fusion. Returns rowid -> fused score.

    Reference: Cormack, Clarke & Buettcher, "Reciprocal Rank Fusion outperforms
    Condorcet and individual rank learning methods", SIGIR 2009.
    https://plg.uwaterloo.ca/~gvcormack/cormacksigir09-rrf.pdf
    """
    fused: dict[int, float] = {}
    for ranking in rankings:
        for rank, (rowid, _score) in enumerate(ranking, start=1):
            fused[rowid] = fused.get(rowid, 0.0) + 1.0 / (k + rank)
    return fused


# Centrality boost: combine RRF score with PageRank centrality.
# We use a multiplicative boost log(1 + γ·centrality·N) so that high-centrality
# nodes get a small lift but the dominant signal stays the query-specific RRF.
# γ is tuned so a centrality at the 95th percentile contributes ~0.1 to log(1+x).
# Reference (motivation): Gutierrez et al., "HippoRAG: Neurobiologically Inspired
# Long-Term Memory for LLMs", NeurIPS 2024 — uses Personalized PageRank to boost
# graph-aware retrieval. We use static (non-personalized) PageRank which is a
# weaker but cheaper proxy when the graph is small.
import math as _math

CENTRALITY_GAMMA = 1000.0  # tuned for our pi values which are O(1e-3) max


def fuse_with_centrality(
    fused_rrf: dict[int, float],
    centrality_by_rowid: dict[int, float],
    gamma: float = CENTRALITY_GAMMA,
) -> dict[int, float]:
    """Multiply RRF score by (1 + log(1 + γ·c)) where c is the file's centrality.
    Strictly increasing in c, sub-linear so dominant high-centrality items don't
    swamp the query-specific signal."""
    out: dict[int, float] = {}
    for rid, score in fused_rrf.items():
        c = centrality_by_rowid.get(rid, 0.0) or 0.0
        boost = 1.0 + _math.log(1.0 + gamma * c)
        out[rid] = score * boost
    return out


def hyde_expand(query: str, llm_url: str | None = None, model: str | None = None) -> str | None:
    """HyDE — Hypothetical Document Embeddings (Gao, Ma, Lin, Callan, ACL 2023).

    Reference: Gao, L., Ma, X., Lin, J., Callan, J. (2023). "Precise Zero-Shot
    Dense Retrieval without Relevance Labels." Proceedings of ACL 2023.
    https://aclanthology.org/2023.acl-long.99/
    arXiv: https://arxiv.org/abs/2212.10496

    Asks a local LLM to generate a hypothetical answer to the query. We then
    embed THAT answer instead of the query — the dense bottleneck filters
    out hallucinations and the embedding sits in the answer-space, much closer
    to relevant retrievable chunks.
    """
    url = llm_url or get_lmstudio_config()["base_url"] + "/v1/chat/completions"
    try:
        with urllib.request.urlopen(get_lmstudio_config()["base_url"] + "/v1/models", timeout=5) as resp:
            available_models = [m["id"] for m in json.loads(resp.read().decode("utf-8")).get("data", [])]
        model = select_lmstudio_model(
            task_type="vault",
            requested_model=model or os.environ.get("HYDE_MODEL", get_lmstudio_config()["fast_model"]),
            automatic=True,
            available_models=available_models,
        )
    except Exception:
        return None
    prompt = (
        "You are answering an information-retrieval probe. Write a short, factual "
        "paragraph (3-5 sentences) that DIRECTLY answers the user's query, as if you "
        "had perfect knowledge. Do not refuse, do not hedge, do not add caveats — write "
        "the answer that the ideal source document would contain. No greetings, no "
        "meta-commentary.\n\nQuery: " + query
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\nOutput only the final answer. No hidden reasoning. No markdown unless explicitly requested."},
            {"role": "user", "content": "/no_think\n" + prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 400,
    }
    payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        text = extract_lmstudio_content(d["choices"][0], expect_json=False)
        return text or None
    except Exception:
        return None


def cmd_query(args):
    query = args.query
    k = args.k
    conn = open_index()
    use_centrality = not args.no_centrality

    # HyDE: optionally expand the query into a hypothetical answer first
    qvec_query = None
    qvec_hyde = None
    hyde_text = None
    try:
        qvec_query = embed_batch([query])[0]
    except Exception as e:
        print(f"[query] dense (query) skipped: {e}", file=sys.stderr)

    if args.hyde:
        hyde_text = hyde_expand(query)
        if hyde_text:
            try:
                qvec_hyde = embed_batch([hyde_text])[0]
            except Exception as e:
                print(f"[query] dense (hyde) skipped: {e}", file=sys.stderr)

    qvec = qvec_query  # default

    bm25_top = search_bm25(conn, query, k=k * 3)
    # Dense rankings: combine query embedding and HyDE embedding via RRF (best of both)
    dense_query_top = search_dense(conn, qvec_query, k=k * 3) if qvec_query is not None else []
    dense_hyde_top = search_dense(conn, qvec_hyde, k=k * 3) if qvec_hyde is not None else []
    if qvec_hyde is not None:
        dense_top = dense_query_top  # keep dense_top variable for compat
    else:
        dense_top = dense_query_top

    _rankings = [bm25_top, dense_query_top]
    if dense_hyde_top:
        _rankings.append(dense_hyde_top)
    fused_rrf = rrf_fuse(_rankings)
    bm25 = bm25_top  # downstream display compat
    dense = dense_query_top
    if not fused_rrf:
        print("(no results)")
        return

    # Centrality boost (graph-aware retrieval, HippoRAG-inspired)
    centrality_by_rowid = {}
    community_by_rowid = {}
    if use_centrality:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(chunks)").fetchall()}
        if "centrality" in cols:
            rids = list(fused_rrf.keys())
            placeholders = ",".join("?" * len(rids))
            extra_col = ", community_id" if "community_id" in cols else ""
            cent_rows = conn.execute(
                f"SELECT rowid, centrality{extra_col} FROM chunks WHERE rowid IN ({placeholders})",
                rids,
            ).fetchall()
            for row in cent_rows:
                rid = row[0]
                centrality_by_rowid[rid] = row[1] or 0.0
                if extra_col:
                    community_by_rowid[rid] = row[2]

            # Per-community z-score: how central is this chunk WITHIN its community?
            # Avoids the flat-distribution problem when the global graph is dense.
            # Reference for community-aware ranking: Edge et al., GraphRAG (2024),
            # which uses Leiden communities to scope retrieval. We do the simpler
            # community-z-score variant.
            if community_by_rowid:
                from statistics import mean, pstdev
                # Aggregate centrality per community (across the whole index, not just candidates)
                global_stats: dict[int, tuple[float, float]] = {}
                for cid in set(c for c in community_by_rowid.values() if c is not None):
                    rows_c = conn.execute(
                        "SELECT centrality FROM chunks WHERE community_id = ? AND centrality IS NOT NULL",
                        (cid,)
                    ).fetchall()
                    vals = [r[0] for r in rows_c if r[0] is not None]
                    if len(vals) >= 2:
                        m = mean(vals); sd = pstdev(vals) or 1e-9
                        global_stats[cid] = (m, sd)
                # Recompute "effective centrality" as z-score in own community
                eff_centrality: dict[int, float] = {}
                for rid, c in centrality_by_rowid.items():
                    cid = community_by_rowid.get(rid)
                    if cid in global_stats:
                        m, sd = global_stats[cid]
                        # Sigmoid-mapped z-score → bounded boost
                        z = (c - m) / sd
                        eff_centrality[rid] = max(0.0, c) * (1.0 + 0.2 * z)
                    else:
                        eff_centrality[rid] = c
                fused = fuse_with_centrality(fused_rrf, eff_centrality)
            else:
                fused = fuse_with_centrality(fused_rrf, centrality_by_rowid)
        else:
            fused = fused_rrf
    else:
        fused = fused_rrf

    top = sorted(fused.items(), key=lambda x: x[1], reverse=True)[:k]
    rowids = [rid for rid, _ in top]
    placeholders = ",".join("?" * len(rowids))
    chunks = {
        row[0]: row
        for row in conn.execute(
            f"SELECT rowid, file_path, chunk_idx, source, folder, event_at, text FROM chunks WHERE rowid IN ({placeholders})",
            rowids,
        )
    }

    results = []
    for rid, score in top:
        c = chunks.get(rid)
        if not c:
            continue
        rid2, fp, ci, src, folder, ev, text = c
        # Component scores for transparency
        bm25_rank = next((i + 1 for i, (rr, _) in enumerate(bm25_top) if rr == rid), None)
        dense_rank = next((i + 1 for i, (rr, _) in enumerate(dense_top) if rr == rid), None)
        snippet = text[:300].replace("\n", " ")
        results.append({
            "score": round(score, 4),
            "rrf_only": round(fused_rrf.get(rid, 0.0), 4),
            "centrality": round(centrality_by_rowid.get(rid, 0.0), 6),
            "bm25_rank": bm25_rank,
            "dense_rank": dense_rank,
            "source": src,
            "folder": folder,
            "file": fp,
            "chunk": ci,
            "event_at": ev,
            "snippet": snippet,
        })

    if args.format == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        for i, r in enumerate(results, 1):
            print(f"\n[{i}]  score={r['score']:.4f}  rrf={r['rrf_only']:.4f}  cent={r['centrality']:.2e}  bm25_rank={r['bm25_rank']}  dense_rank={r['dense_rank']}  source={r['source']}")
            print(f"     {r['file']} (chunk {r['chunk']})")
            print(f"     {r['snippet']}...")


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(prog="vault_brain")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_idx = sub.add_parser("index", help="(Re)build the index")
    p_idx.add_argument("--incremental", action="store_true", help="Only embed new/changed chunks")

    p_q = sub.add_parser("query", help="Hybrid search (BM25 + dense + RRF + centrality)")
    p_q.add_argument("query", help="Query text")
    p_q.add_argument("-k", type=int, default=10, help="Number of results")
    p_q.add_argument("--format", choices=["text", "json"], default="text")
    p_q.add_argument("--no-centrality", action="store_true", help="Disable PageRank centrality boost")
    p_q.add_argument("--hyde", action="store_true", help="Enable HyDE: generate hypothetical answer via local LLM, fuse its embedding into the dense ranking (Gao et al., ACL 2023)")

    sub.add_parser("stats", help="Index statistics")

    args = parser.parse_args()
    if args.cmd == "index":
        cmd_index(args)
    elif args.cmd == "query":
        cmd_query(args)
    elif args.cmd == "stats":
        cmd_stats(args)


if __name__ == "__main__":
    main()
