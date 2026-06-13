"""
vault_eval.py — Evaluation harness for the vault brain.

Measures:
  - Recall@k (k=1, 5, 10, 20)
  - MRR (Mean Reciprocal Rank)
  - Per-strategy: BM25-only, dense-only, hybrid (RRF)

Generates synthetic queries from existing curated docs (decisions, runbook,
topology) by extracting representative phrases via a small LLM call. Each
synthetic query is paired with its source file as ground truth — we then check
whether retrieval surfaces that file in the top-K.

Citations:
  - Voorhees (1999) — TREC: Reciprocal Rank metric
  - Cormack et al. (2009) — Recall@k methodology for fusion ranking
  - Lin et al. (2024) — RRF baseline for MS MARCO

Usage:
  python vault_eval.py generate --out queries.json    # build synthetic test set
  python vault_eval.py run queries.json                # run all 3 strategies
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
import json
import os
import random
import re
import sys
import time
import urllib.request
from pathlib import Path

# Reuse the brain functions
sys.path.insert(0, str(Path(__file__).parent))
from vault_brain import (
    VAULT_PATH, open_index, embed_batch, search_bm25, search_dense, rrf_fuse,
    fuse_with_centrality, EMBED_URL,
)

GENERATE_PROMPT = """Given the following note from an engineering knowledge base, generate 2 SHORT user queries (each 5-12 words) that a future user would plausibly type to find this exact information. The queries should:
- be in natural language, not just keywords
- be specific enough that THIS note is the right answer
- vary in style (one keyword-heavy, one paraphrased)

Output EXACTLY two lines, no numbering, no prose. Each line is one query.

Note (file: {file_path}):
---
{snippet}
---"""


def call_llm(prompt: str, model: str | None = None) -> str:
    try:
        with urllib.request.urlopen(get_lmstudio_config()["base_url"] + "/v1/models", timeout=5) as resp:
            available_models = [m["id"] for m in json.loads(resp.read().decode("utf-8")).get("data", [])]
        model = select_lmstudio_model(
            task_type="eval",
            requested_model=model or os.environ.get("EVAL_MODEL", get_lmstudio_config()["fast_model"]),
            automatic=True,
            available_models=available_models,
        )
    except Exception as e:
        return f"__error__ {e}"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\nOutput only the final answer. No hidden reasoning. No markdown unless explicitly requested."},
            {"role": "user", "content": "/no_think\n" + prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 200,
    }
    payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
    req = urllib.request.Request(
        get_lmstudio_config()["base_url"] + "/v1/chat/completions",
        data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        return extract_lmstudio_content(d["choices"][0], expect_json=False)
    except Exception as e:
        return f"__error__ {e}"


def cmd_generate(args):
    """Sample N curated files, generate 2 queries each."""
    conn = open_index()
    rows = conn.execute(
        "SELECT DISTINCT file_path FROM chunks WHERE source IN ('curated','procedural','semantic') AND chunk_idx = 0 LIMIT 500"
    ).fetchall()
    files = [r[0] for r in rows]
    random.seed(42)
    sample = random.sample(files, min(args.n, len(files)))

    queries = []
    for i, fp in enumerate(sample, 1):
        row = conn.execute(
            "SELECT text FROM chunks WHERE file_path=? AND chunk_idx=0", (fp,)
        ).fetchone()
        if not row:
            continue
        snippet = row[0][:1500]
        prompt = GENERATE_PROMPT.format(file_path=fp, snippet=snippet)
        out = call_llm(prompt)
        if out.startswith("__error__"):
            print(f"[generate] WARN {fp}: {out}", file=sys.stderr)
            continue
        lines = [l.strip(" -*0123456789.") for l in out.splitlines() if l.strip()]
        for q in lines[:2]:
            if 4 <= len(q.split()) <= 20:
                queries.append({"query": q, "expected_file": fp})
        print(f"[generate] {i}/{len(sample)}  {fp[:50]}: {len(lines[:2])} queries")
    Path(args.out).write_text(json.dumps(queries, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n[generate] wrote {len(queries)} queries to {args.out}")


def evaluate(queries: list[dict], strategy: str, k_values: list[int]) -> dict:
    """Run a strategy across queries, return metrics."""
    conn = open_index()
    metrics = {f"recall@{k}": 0 for k in k_values}
    metrics["mrr"] = 0.0
    metrics["n"] = len(queries)
    metrics["queries_with_hit"] = 0

    max_k = max(k_values)
    for q in queries:
        query, expected = q["query"], q["expected_file"]
        needs_dense = strategy in ("dense", "hybrid", "hybrid_centrality")
        needs_bm25 = strategy in ("bm25", "hybrid", "hybrid_centrality")
        try:
            qvec = embed_batch([query])[0] if needs_dense else None
        except Exception:
            qvec = None
        bm25 = search_bm25(conn, query, k=max_k * 3) if needs_bm25 else []
        dense = search_dense(conn, qvec, k=max_k * 3) if (qvec and needs_dense) else []

        if strategy == "bm25":
            ranked = [rid for rid, _ in bm25]
        elif strategy == "dense":
            ranked = [rid for rid, _ in dense]
        elif strategy == "hybrid":
            fused = rrf_fuse([bm25, dense])
            ranked = [rid for rid, _ in sorted(fused.items(), key=lambda x: x[1], reverse=True)]
        elif strategy == "hybrid_centrality":
            fused = rrf_fuse([bm25, dense])
            # Load centrality for the candidate rowids
            rids = list(fused.keys())
            if rids:
                placeholders = ",".join("?" * len(rids))
                cent = {r[0]: r[1] for r in conn.execute(
                    f"SELECT rowid, centrality FROM chunks WHERE rowid IN ({placeholders})", rids
                ).fetchall()}
                fused = fuse_with_centrality(fused, cent)
            ranked = [rid for rid, _ in sorted(fused.items(), key=lambda x: x[1], reverse=True)]
        else:
            raise ValueError(strategy)

        if not ranked:
            continue
        # Map rowid -> file_path (top-K only)
        top_rids = ranked[:max_k]
        if not top_rids:
            continue
        placeholders = ",".join("?" * len(top_rids))
        rows = conn.execute(
            f"SELECT rowid, file_path FROM chunks WHERE rowid IN ({placeholders})", top_rids
        ).fetchall()
        rid_to_file = {rid: fp for rid, fp in rows}
        ranked_files = [rid_to_file.get(rid, "") for rid in top_rids]

        # First match position
        try:
            pos = next(i for i, fp in enumerate(ranked_files, 1) if fp == expected)
            metrics["mrr"] += 1.0 / pos
            metrics["queries_with_hit"] += 1
            for k in k_values:
                if pos <= k:
                    metrics[f"recall@{k}"] += 1
        except StopIteration:
            pass

    n = max(metrics["n"], 1)
    metrics["mrr"] = round(metrics["mrr"] / n, 4)
    for k in k_values:
        metrics[f"recall@{k}"] = round(metrics[f"recall@{k}"] / n, 4)
    return metrics


def cmd_run(args):
    queries = json.loads(Path(args.queries).read_text(encoding="utf-8"))
    print(f"[eval] {len(queries)} queries loaded from {args.queries}")
    k_values = [1, 5, 10, 20]
    results = {}
    strategies = args.strategies.split(",") if args.strategies else ["bm25", "dense", "hybrid", "hybrid_centrality"]
    for strategy in strategies:
        t0 = time.time()
        metrics = evaluate(queries, strategy, k_values)
        elapsed = time.time() - t0
        print(f"\n=== Strategy: {strategy} ({elapsed:.1f}s) ===")
        for k in k_values:
            print(f"  Recall@{k:>2}: {metrics[f'recall@{k}']:.4f}")
        print(f"  MRR     : {metrics['mrr']:.4f}")
        print(f"  hits    : {metrics['queries_with_hit']}/{metrics['n']}")
        results[strategy] = metrics

    # Pretty markdown report saved to vault for transparency
    report_path = VAULT_PATH / "06 - Agents" / f"eval-{time.strftime('%Y-%m-%d')}.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "---",
        f'type: "evaluation"',
        f'created: "{time.strftime("%Y-%m-%d")}"',
        f'tags: ["evaluation","retrieval","brain"]',
        "---",
        "",
        f"# Vault Brain Retrieval Evaluation — {time.strftime('%Y-%m-%d')}",
        "",
        f"Test set: **{len(queries)} synthetic queries** generated from curated docs (decisions, runbook, topology).",
        "",
        "| Strategy | Recall@1 | Recall@5 | Recall@10 | Recall@20 | MRR |",
        "|---|---|---|---|---|---|",
    ]
    for s in strategies:
        m = results[s]
        lines.append(f"| {s} | {m['recall@1']:.4f} | {m['recall@5']:.4f} | {m['recall@10']:.4f} | {m['recall@20']:.4f} | {m['mrr']:.4f} |")
    lines += ["", "## Interpretation", "",
              "- **BM25** (sparse, lexical) — strong on exact identifiers, weak on paraphrase.",
              "- **Dense** (nomic-embed-text v1.5, 768d) — strong on semantic match, weak on rare tokens.",
              "- **Hybrid (RRF k=60)** — should beat both; if it doesn't, the index has gaps or the queries are too easy.",
              "",
              "Citations:",
              "- Cormack, Clarke, Buettcher (2009) — *Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods*",
              "- Lin et al. (2024) — RRF baseline reproductions on MS MARCO",
              "- Voorhees (1999) — Mean Reciprocal Rank, TREC-8",
              ""]
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n[eval] report written to {report_path}")
    print(json.dumps(results, indent=2))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_g = sub.add_parser("generate")
    p_g.add_argument("--out", default=str(VAULT_PATH / ".eval-queries.json"))
    p_g.add_argument("-n", type=int, default=30)
    p_r = sub.add_parser("run")
    p_r.add_argument("queries")
    p_r.add_argument("--strategies", default="", help="Comma-list, e.g. bm25,dense,hybrid,hybrid_centrality")
    args = ap.parse_args()
    if args.cmd == "generate":
        cmd_generate(args)
    elif args.cmd == "run":
        cmd_run(args)


if __name__ == "__main__":
    main()
