"""
vault_consolidate.py — Mem0-style episodic → semantic extraction.

Reads recent notes from `07 - Ingested/` and extracts atomic facts into
`08 - Semantic/<topic>/<fact-id>.md`. Single-pass ADD-only per Chhikara et al.
(Mem0, arXiv:2504.19413, 2025): never UPDATE/DELETE — accumulate, don't overwrite.

Each extracted fact is:
- atomic (one claim per note)
- traceable (frontmatter `derived_from:` lists source notes)
- bi-temporal (event_at = source event time, captured_at = extraction time)
- typed (`fact_type` = decision | preference | constraint | observation | reference)

Uses qwen3.6-35b-a3b via LM Studio (local, no quota cost) as the extraction LLM.

Usage:
  python vault_consolidate.py --since 24h --dry-run     # preview
  python vault_consolidate.py --since 24h --apply       # write notes
  python vault_consolidate.py --since 7d --max-files 200
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
import datetime as dt
import hashlib
import json
import os
import re
import time
import urllib.request
from pathlib import Path

VAULT_PATH = Path(os.environ.get("VAULT_PATH", r"C:\Users\Smedj\Documents\Obsidian Vault"))
INGESTED_DIR = VAULT_PATH / "07 - Ingested"
SEMANTIC_DIR = VAULT_PATH / "08 - Semantic"
LM_STUDIO_URL = get_lmstudio_config()["base_url"] + "/v1/chat/completions"
EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", get_lmstudio_config()["fast_model"])
STATE_FILE = VAULT_PATH / ".vault-consolidate-state.json"

EXTRACTION_PROMPT = """You are an information-extraction module for a long-term agent memory.

Read the input note and produce a JSON array of atomic FACTS that should be remembered for future sessions. Each fact must be:
- ATOMIC: one claim per fact, fully self-contained
- TYPED: fact_type ∈ ["decision","preference","constraint","observation","reference"]
- DURABLE: would still be useful in 3 months, not session-trivia
- SHORT: 1-2 sentences

Skip the note entirely if it contains nothing durable (small talk, "ok", trivial confirmations, build output, errors that were resolved within the same session). Output `[]` in that case.

Respond with ONLY a valid JSON array. No prose, no markdown fences. Schema:
[
  {
    "fact_type": "decision|preference|constraint|observation|reference",
    "topic": "short-slug-for-folder",
    "title": "Imperative title under 80 chars",
    "claim": "1-2 sentence durable claim",
    "tags": ["topic/x","agent/y"]
  }
]

Input note:
---
"""


def call_llm(note_text: str, retries: int = 2) -> list[dict]:
    """Call qwen via LM Studio chat/completions. Return parsed JSON list or []."""
    try:
        with urllib.request.urlopen(get_lmstudio_config()["base_url"] + "/v1/models", timeout=5) as resp:
            available_models = [m["id"] for m in json.loads(resp.read().decode("utf-8")).get("data", [])]
        model = select_lmstudio_model(
            task_type="consolidate",
            requested_model=EXTRACT_MODEL,
            automatic=True,
            available_models=available_models,
        )
    except Exception as e:
        print(f"[consolidate] LM Studio model selection failed: {e}")
        return []
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": EXTRACTION_PROMPT + note_text[:8000]},  # cap input for safety
        ],
        "temperature": 0.1,
        "max_tokens": 2000,
    }
    payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
    req = urllib.request.Request(LM_STUDIO_URL, data=payload, headers={"Content-Type": "application/json"})
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                d = json.loads(resp.read().decode("utf-8"))
            content = extract_lmstudio_content(d["choices"][0], expect_json=True)
            # Remove ```json fences if model added them despite instructions
            content = re.sub(r"^```(?:json)?\s*", "", content)
            content = re.sub(r"\s*```$", "", content)
            if not content or content == "[]":
                return []
            facts = json.loads(content)
            if not isinstance(facts, list):
                return []
            return facts
        except json.JSONDecodeError as e:
            last_err = f"JSON: {e}; raw: {content[:200]}"
        except Exception as e:
            last_err = str(e)
            time.sleep(0.5 * (attempt + 1))
    print(f"[consolidate] LLM call failed: {last_err}", file=sys.stderr if False else None)
    return []


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"processed_files": {}}  # path -> last_consolidated_iso


def save_state(state: dict):
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


def parse_since(arg: str) -> dt.datetime:
    """Accept '24h', '7d', '30m'. Return UTC cutoff."""
    m = re.match(r"^(\d+)([hdm])$", arg)
    if not m:
        raise ValueError(f"--since must be like '24h', '7d', '30m', got {arg!r}")
    n, unit = int(m.group(1)), m.group(2)
    delta = {"h": dt.timedelta(hours=n), "d": dt.timedelta(days=n), "m": dt.timedelta(minutes=n)}[unit]
    return dt.datetime.now(dt.timezone.utc) - delta


def extract_event_at(text: str) -> dt.datetime | None:
    m = re.search(r"^event_at:\s*\"?([^\"\n]+)\"?", text, re.MULTILINE)
    if not m:
        return None
    try:
        return dt.datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
    except Exception:
        return None


def write_fact(fact: dict, source_rel: str, event_at: dt.datetime | None) -> Path:
    topic = re.sub(r"[^\w\-]", "-", fact.get("topic", "general")).lower().strip("-")[:40] or "general"
    title = fact.get("title", "untitled")[:80]
    slug = re.sub(r"[^\w\-]", "-", title).strip("-")[:60]
    fact_id = hashlib.sha256(f"{source_rel}::{title}".encode()).hexdigest()[:10]
    folder = SEMANTIC_DIR / topic
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{fact_id}-{slug}.md"
    if path.exists():
        return path  # idempotent — already extracted

    captured_at = dt.datetime.now(dt.timezone.utc).isoformat()
    event_iso = event_at.isoformat() if event_at else captured_at
    fact_type = fact.get("fact_type", "observation")
    raw_tags = fact.get("tags", []) or []
    tags = [str(t) for t in raw_tags] + [f"fact/{fact_type}", f"topic/{topic}", "ingested-fact"]

    fm_lines = [
        "---",
        f'type: "semantic-fact"',
        f'fact_type: "{fact_type}"',
        f'topic: "{topic}"',
        f'event_at: "{event_iso}"',
        f'captured_at: "{captured_at}"',
        f'derived_from: ["{source_rel}"]',
        f'tags: [{", ".join(json.dumps(t) for t in tags)}]',
        "---",
        "",
        f"# {title}",
        "",
        fact.get("claim", "(no claim)"),
        "",
        f"---",
        f"Derived from [[{source_rel}]] on {captured_at}.",
    ]
    path.write_text("\n".join(fm_lines), encoding="utf-8")
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="24h", help="Relative window: 24h, 7d, 30m")
    ap.add_argument("--apply", action="store_true", help="Actually write fact notes (default is dry-run)")
    ap.add_argument("--max-files", type=int, default=500, help="Cap files processed per run")
    ap.add_argument("--source-glob", default="*.md", help="Glob within 07 - Ingested/")
    args = ap.parse_args()

    cutoff = parse_since(args.since)
    state = load_state()

    candidates = []
    if INGESTED_DIR.exists():
        for f in INGESTED_DIR.rglob(args.source_glob):
            if not f.is_file():
                continue
            rel = f.relative_to(VAULT_PATH).as_posix()
            if rel in state["processed_files"]:
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            ev = extract_event_at(text)
            if ev and ev < cutoff:
                continue
            candidates.append((f, rel, text, ev))

    candidates = candidates[: args.max_files]
    print(f"[consolidate] {len(candidates)} candidate ingested note(s) since {args.since} (cutoff: {cutoff.isoformat()})")
    print(f"[consolidate] mode: {'APPLY' if args.apply else 'DRY-RUN'}")

    total_facts = 0
    extracted_files = 0
    t0 = time.time()
    for i, (f, rel, text, ev) in enumerate(candidates, 1):
        # Trim frontmatter from the LLM input — we already have the metadata
        body = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.DOTALL)
        if len(body.strip()) < 80:
            continue
        facts = call_llm(body)
        if facts:
            extracted_files += 1
            for fact in facts:
                if not isinstance(fact, dict):
                    continue
                if args.apply:
                    p = write_fact(fact, rel, ev)
                    total_facts += 1
                else:
                    print(f"  [{rel}] {fact.get('fact_type','?'):12} {fact.get('topic','?'):20} {fact.get('title','')[:60]}")
                    total_facts += 1
        if args.apply:
            state["processed_files"][rel] = dt.datetime.now(dt.timezone.utc).isoformat()
            if i % 20 == 0:
                save_state(state)
                print(f"[consolidate] {i}/{len(candidates)} processed, {total_facts} facts so far ({time.time()-t0:.0f}s)")

    if args.apply:
        save_state(state)
    print(f"\n[consolidate] done. {extracted_files} files yielded {total_facts} facts in {time.time()-t0:.0f}s")
    if args.apply:
        print(f"[consolidate] state: {STATE_FILE}")


if __name__ == "__main__":
    import sys
    main()
