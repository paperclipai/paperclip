"""
vault_synthesizer.py — The brain that writes about itself.

For each Label-Propagation community of size >= MIN_SIZE, generate a
"community summary" note that:
  1. Lists all members of the cluster (wikilinks)
  2. Identifies the dominant theme (top TextRank phrases shared)
  3. Asks the local LLM (qwen3.6 via LM Studio) to write a 5-sentence
     synthesis describing what this cluster is about
  4. Cites the most central member as the "anchor" of the cluster
  5. Drops a note in 08 - Semantic/communities/

This makes the brain an *active* participant: it discovers structure (via
LPA), then describes that structure in human-readable form. New synthesis
notes themselves become high-degree hubs in the graph (each links to all
their cluster members), which dramatically improves PageRank centrality
and navigability.

Theoretical foundation (peer-reviewed):
  - Park, J. S. et al. (2023). "Generative Agents." UIST 2023.
    DOI: 10.1145/3586183.3606763. The "reflection" component of generative
    agents writes higher-level abstractions over recent episodic memories.
    This synthesizer applies the same pattern to graph communities.
  - Raghavan, U. N., Albert, R., Kumara, S. (2007). "Near linear time
    algorithm to detect community structures." Physical Review E 76(3),
    036106. DOI: 10.1103/PhysRevE.76.036106. (Provides the communities
    we summarize.)
  - Mihalcea, R., Tarau, P. (2004). "TextRank: Bringing Order into Texts."
    EMNLP 2004. (Provides the dominant phrases per community.)

Usage:
  python vault_synthesizer.py --apply                 # synthesize all communities >= 5
  python vault_synthesizer.py --apply --min-size 10   # only big clusters
  python vault_synthesizer.py --apply --max-clusters 20  # cap LLM calls
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
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VAULT_PATH = Path(os.environ.get("VAULT_PATH", r"C:\Users\Smedj\Documents\Obsidian Vault"))
COMMUNITIES_FILE = VAULT_PATH / ".vault-communities.json"
KEYPHRASES_FILE = VAULT_PATH / ".vault-keyphrases.json"
PAGERANK_FILE = VAULT_PATH / ".vault-pagerank.json"
COMMUNITY_DIR = VAULT_PATH / "08 - Semantic" / "communities"
LM_STUDIO_URL = get_lmstudio_config()["base_url"] + "/v1/chat/completions"
SYNTH_MODEL = os.environ.get("SYNTH_MODEL", get_lmstudio_config()["deep_model"])

# Tiered model preference for synthesis. Per the operator's correction (2026-04-29):
# Claude (this session) and GPT-5.5 (codex CLI) are flagships; qwen3.6 is fallback /
# token-saver for when both flagships are tapped out (cf. 04 - Quota & Cost/Strategy).
#
# This module only handles the qwen3.6 path (fastest to plumb, no auth). The claude-direct
# path is invoked by Claude itself writing the synthesis in-session (see existing
# community-XXXX notes written 2026-04-29). The gpt-5.5 path uses codex CLI in --exec mode.
PROMPT_FOR_FLAGSHIP_PATH = """If you want Claude or GPT-5.5 to write this synthesis directly
instead of calling qwen3.6, paste the prompt below into the active session:

---
{prompt}
---

Then write the resulting markdown into:
{out_path}
"""


SYNTH_PROMPT = """You are summarizing a cluster of related notes from an engineering knowledge base.

The cluster has the following dominant phrases (most-shared TextRank keywords across notes):
{phrases}

The cluster contains {n} notes. Here are titles of representative members:
{titles}

Write EXACTLY:
1. A 1-line theme name (under 8 words) that captures what this cluster is about.
2. A 4-5 sentence synthesis describing the common thread, recurring decisions, and any tensions.
3. One concrete TODO that an agent should pick up to either resolve a tension or extend the cluster.

Format strictly as YAML:
theme: "..."
synthesis: "..."
todo: "..."

Do not add prose, explanations, or markdown fences. Output ONLY the YAML."""


def call_llm(prompt: str, retries: int = 2, timeout: int = 90) -> str | None:
    try:
        with urllib.request.urlopen(get_lmstudio_config()["base_url"] + "/v1/models", timeout=5) as resp:
            available_models = [m["id"] for m in json.loads(resp.read().decode("utf-8")).get("data", [])]
        model = select_lmstudio_model(
            task_type="long_synthesis",
            requested_model=SYNTH_MODEL,
            automatic=True,
            available_models=available_models,
        )
    except Exception as e:
        print(f"[synth]   LM Studio model selection failed: {e}", file=sys.stderr)
        return None
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\nOutput only the final answer. No hidden reasoning. No markdown unless explicitly requested."},
            {"role": "user", "content": "/no_think\n" + prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 600,
    }
    payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
    for attempt in range(retries):
        try:
            req = urllib.request.Request(LM_STUDIO_URL, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                d = json.loads(resp.read().decode("utf-8"))
            return extract_lmstudio_content(d["choices"][0], expect_json=False)
        except Exception as e:
            if attempt == retries - 1:
                print(f"[synth]   LLM call failed: {e}", file=sys.stderr)
            time.sleep(1)
    return None


def parse_synth_yaml(raw: str) -> dict | None:
    if not raw:
        return None
    raw = raw.strip()
    # Strip code fences
    raw = re.sub(r"^```(?:yaml)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    out = {}
    for line in raw.splitlines():
        m = re.match(r'\s*(theme|synthesis|todo)\s*:\s*"?(.+?)"?\s*$', line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    if "theme" in out and "synthesis" in out:
        return out
    return None


def build_community_phrases(community_paths: list[str], keyphrases: dict[str, list[str]],
                            top: int = 8) -> list[tuple[str, int]]:
    counter = Counter()
    for path in community_paths:
        for p in keyphrases.get(path, []):
            counter[p] += 1
    return counter.most_common(top)


def render_note(community_id: int, paths: list[str], theme: str, synthesis: str, todo: str,
                top_phrases: list[tuple[str, int]], anchor: str | None) -> str:
    lines = [
        "---",
        f'type: "community-synthesis"',
        f'community_id: {community_id}',
        f'created: "{dt.datetime.now(dt.timezone.utc).isoformat()}"',
        f'member_count: {len(paths)}',
        f'tags: ["community-synthesis","auto-generated","layer-2"]',
        "---",
        "",
        f"# Community {community_id} — {theme}",
        "",
        "## Synthesis",
        "",
        synthesis,
        "",
        "## TODO",
        "",
        f"- {todo}",
        "",
        "## Anchor",
        "",
        f"- [[{anchor[:-3] if anchor and anchor.endswith('.md') else anchor}]]" if anchor else "*(no anchor)*",
        "",
        "## Dominant phrases",
        "",
    ]
    for p, c in top_phrases:
        lines.append(f"- `{p}` ({c} notes)")
    lines += ["", "## Members", ""]
    for p in paths[:60]:
        target = p[:-3] if p.endswith(".md") else p
        lines.append(f"- [[{target.replace(chr(92), '/')}]]")
    if len(paths) > 60:
        lines.append(f"- *(...and {len(paths) - 60} more — see graph)*")
    lines += [
        "",
        "---",
        "",
        "*Auto-synthesized from Label-Propagation community detection ([Raghavan, Albert & Kumara, "
        "Phys. Rev. E 76(3), 2007](https://doi.org/10.1103/PhysRevE.76.036106)) over the densified wikilink graph. "
        "Synthesis written by `qwen3.6-35b-a3b` (local, no API cost).*",
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--min-size", type=int, default=5)
    ap.add_argument("--max-clusters", type=int, default=15)
    ap.add_argument("--rewrite", action="store_true")
    ap.add_argument("--emit-prompts", action="store_true",
                    help="Don't call any LLM — print prompts for Claude/GPT to fill in interactively. "
                         "Use this in active sessions where the operator has Claude or GPT-5.5 ready.")
    ap.add_argument("--via-codex", action="store_true",
                    help="Call OpenAI Codex CLI (gpt-5.5) instead of LM Studio (qwen3.6). "
                         "Faster but uses ChatGPT quota.")
    args = ap.parse_args()

    if not COMMUNITIES_FILE.exists():
        print("[synth] missing communities — run vault_communities.py detect")
        sys.exit(1)
    if not KEYPHRASES_FILE.exists():
        print("[synth] missing keyphrases — run vault_textrank.py extract")
        sys.exit(1)

    com = json.loads(COMMUNITIES_FILE.read_text(encoding="utf-8"))
    nodes = com["nodes"]
    labels = com["labels"]
    keyphrases = json.loads(KEYPHRASES_FILE.read_text(encoding="utf-8"))
    pr = {}
    if PAGERANK_FILE.exists():
        pr = json.loads(PAGERANK_FILE.read_text(encoding="utf-8")).get("pagerank", {})

    # Group nodes by community
    members: dict[int, list[str]] = defaultdict(list)
    for i, lbl in enumerate(labels):
        members[lbl].append(nodes[i])

    eligible = sorted(
        [(cid, paths) for cid, paths in members.items() if len(paths) >= args.min_size],
        key=lambda x: -len(x[1]),
    )
    print(f"[synth] {len(eligible)} communities with size >= {args.min_size}")
    eligible = eligible[: args.max_clusters]
    print(f"[synth] processing top {len(eligible)} (capped by --max-clusters)")

    if args.apply:
        COMMUNITY_DIR.mkdir(parents=True, exist_ok=True)

    written = 0
    for cid, paths in eligible:
        out_path = COMMUNITY_DIR / f"community-{cid:04d}.md"
        if out_path.exists() and not args.rewrite:
            print(f"[synth] community {cid}: file exists, skip (use --rewrite to overwrite)")
            continue

        top_phrases = build_community_phrases(paths, keyphrases, top=8)
        if not top_phrases:
            print(f"[synth] community {cid}: no phrases, skipping")
            continue

        # Pick anchor = highest-PageRank member
        anchor = max(paths, key=lambda p: pr.get(p, 0.0)) if pr else paths[0]

        # Sample titles for prompt (first chunk = title)
        titles = []
        for p in paths[:8]:
            stem = Path(p).stem.replace("-", " ").replace("_", " ")
            stem = re.sub(r"^\d{2}-\d{2}-\d{2}\s*", "", stem)
            titles.append(f"  - {stem[:80]}")

        prompt = SYNTH_PROMPT.format(
            phrases=", ".join(f"`{p}`" for p, _ in top_phrases),
            n=len(paths),
            titles="\n".join(titles),
        )

        if args.emit_prompts:
            # Print the prompt so Claude or GPT-5.5 (in active session) can fill it in.
            print("=" * 80)
            print(PROMPT_FOR_FLAGSHIP_PATH.format(prompt=prompt, out_path=out_path))
            print("=" * 80)
            continue

        if args.via_codex:
            print(f"[synth] community {cid:4d}: routing via Codex CLI (gpt-5.5)…")
            try:
                import subprocess as _sp
                t0 = time.time()
                res = _sp.run(["codex", "exec", "--skip-git-repo-check", prompt],
                              capture_output=True, text=True, timeout=120)
                raw = res.stdout.strip()
                elapsed = time.time() - t0
            except Exception as e:
                print(f"[synth] codex failed: {e}; falling back to qwen3.6")
                t0 = time.time()
                raw = call_llm(prompt)
                elapsed = time.time() - t0
        else:
            print(f"[synth] community {cid:4d} ({len(paths)} notes): calling qwen3.6 (fallback tier)…")
            t0 = time.time()
            raw = call_llm(prompt)
            elapsed = time.time() - t0
        if not raw:
            print(f"[synth] community {cid}: LLM returned nothing ({elapsed:.0f}s)")
            continue
        parsed = parse_synth_yaml(raw)
        if not parsed:
            print(f"[synth] community {cid}: parse failed; raw[:120]={raw[:120]!r}")
            continue
        theme = parsed.get("theme", "(untitled)")
        synthesis = parsed.get("synthesis", "")
        todo = parsed.get("todo", "")
        print(f"[synth] community {cid}: '{theme}' ({elapsed:.0f}s)")

        note = render_note(cid, paths, theme, synthesis, todo, top_phrases, anchor)
        if args.apply:
            out_path.write_text(note, encoding="utf-8")
            written += 1

    print()
    print(f"[synth] wrote {written} synthesis note(s) to {COMMUNITY_DIR}")
    print(f"[synth] mode: {'APPLIED' if args.apply else 'DRY-RUN'}")


if __name__ == "__main__":
    main()
