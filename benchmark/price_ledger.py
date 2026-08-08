#!/usr/bin/env python3
"""price_ledger.py — public API list-price → subscription-pool draw weights.

Canonical machine-readable companion to the operator price ledger
(TSMC-19782 → TSMC-20229). Used by:

  * report.py / costreport.py — quality ÷ input_weight (score-per-weight)
  * usage.py — tokens × input_weight (Terra-equivalent weighted burn)
  * lane policy docs (TSKB0056)

Anchor: weight = usd_per_1m_input / 2.50 (nominal Terra $2.50 unit). After the
July-2026 OpenAI cut, live Terra is $2/$12 → weight 0.80; the $2.50 divisor is
kept so weights stay comparable across generations.

  python3 price_ledger.py summary
  python3 price_ledger.py lookup gpt-5.5
  python3 price_ledger.py weighted-burn --input 749000000 --model gpt-5.5
  python3 price_ledger.py selftest
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from functools import lru_cache
from pathlib import Path

LEDGER_PATH = Path(__file__).resolve().parent / "price_ledger.json"
ANCHOR_USD = 2.5


def _clean(value: object) -> str:
    return str(value or "").strip().lower()


def _norm_key(value: object) -> str:
    s = _clean(value)
    s = s.replace("codex/", "").replace("openai/", "").replace("anthropic/", "")
    s = s.replace("models/", "")
    s = re.sub(r"^agy[-_]", "", s)
    s = s.replace("_", "-")
    return s


@lru_cache(maxsize=1)
def load_ledger(path: str | None = None) -> dict:
    p = Path(path) if path else LEDGER_PATH
    with open(p) as f:
        data = json.load(f)
    if not isinstance(data, dict) or "rows" not in data:
        raise ValueError(f"invalid price ledger at {p}")
    return data


def reload_ledger(path: str | None = None) -> dict:
    load_ledger.cache_clear()
    return load_ledger(path)


def _alias_index(data: dict | None = None) -> dict[str, dict]:
    data = data or load_ledger()
    index: dict[str, dict] = {}
    for row in data.get("rows") or []:
        keys = {_norm_key(row.get("id")), _norm_key(row.get("served_public_model"))}
        for alias in row.get("aliases") or []:
            keys.add(_norm_key(alias))
        for key in keys:
            if key:
                index[key] = row
    return index


def lookup_row(model: object, data: dict | None = None) -> dict | None:
    """Return the ledger row for a model id / alias / usage_json model string."""
    data = data or load_ledger()
    index = _alias_index(data)
    raw = _norm_key(model)
    if not raw:
        return None
    if raw in index:
        return index[raw]

    # progressive suffix / containment fallback (longest alias wins)
    candidates = []
    for key, row in index.items():
        if not key:
            continue
        if raw == key or raw.endswith("-" + key) or raw.endswith("/" + key) or key in raw:
            candidates.append((len(key), row))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def input_weight(
    model: object,
    *,
    input_tokens: int | float | None = None,
    data: dict | None = None,
    default: float | None = None,
) -> float | None:
    """Return input weight for model; apply long-context overlay when tokens known."""
    row = lookup_row(model, data)
    if not row:
        return default
    weight = row.get("input_weight")
    lc = row.get("long_context") or {}
    threshold = lc.get("threshold_input_tokens")
    if (
        weight is not None
        and input_tokens is not None
        and threshold is not None
        and float(input_tokens) > float(threshold)
        and lc.get("input_weight") is not None
    ):
        return float(lc["input_weight"])
    if weight is None:
        return default
    return float(weight)


def score_per_weight(
    quality: float | int | None,
    model: object,
    *,
    input_tokens: int | float | None = None,
    data: dict | None = None,
) -> float | None:
    """quality ÷ input_weight. Higher is better pool-efficiency at equal quality."""
    if quality is None:
        return None
    w = input_weight(model, input_tokens=input_tokens, data=data)
    if w is None or w <= 0:
        return None
    return float(quality) / w


def weighted_tokens(
    tokens: int | float | None,
    model: object,
    *,
    input_tokens_for_context: int | float | None = None,
    data: dict | None = None,
) -> float | None:
    """tokens × input_weight → Terra-equivalent pool-draw units (nominal $2.50)."""
    if tokens is None:
        return None
    w = input_weight(
        model,
        input_tokens=input_tokens_for_context if input_tokens_for_context is not None else tokens,
        data=data,
    )
    if w is None:
        return None
    return float(tokens) * w


def pricing_dict_for_config(data: dict | None = None) -> dict[str, dict]:
    """Map common bench model ids → {in, out} for config.pricing / costreport."""
    data = data or load_ledger()
    out: dict[str, dict] = {}
    for row in data.get("rows") or []:
        if row.get("usd_per_1m_input") is None and row.get("usd_per_1m_output") is None:
            continue
        payload = {
            "in": row.get("usd_per_1m_input"),
            "out": row.get("usd_per_1m_output"),
            "input_weight": row.get("input_weight"),
            "ledger_id": row.get("id"),
        }
        keys = {row.get("id"), *(row.get("aliases") or [])}
        for key in keys:
            nk = _norm_key(key)
            if nk:
                out[nk] = payload
                # also keep original-ish keys used in config.json
                out[str(key)] = payload
    return out


def sync_config_pricing(config_path: Path | None = None) -> dict:
    """Fill null/missing config.pricing entries from the ledger; return diff summary."""
    cfg_path = config_path or (Path(__file__).resolve().parent / "config.json")
    cfg = json.loads(cfg_path.read_text())
    pricing = dict(cfg.get("pricing") or {})
    ledger_prices = pricing_dict_for_config()
    updated = []
    for key, cur in list(pricing.items()):
        if not isinstance(cur, dict):
            continue
        row = lookup_row(key)
        if not row:
            # try ledger prices by normalized key
            row_price = ledger_prices.get(_norm_key(key)) or ledger_prices.get(key)
        else:
            row_price = {
                "in": row.get("usd_per_1m_input"),
                "out": row.get("usd_per_1m_output"),
            }
        if not row_price:
            continue
        new_in = row_price.get("in")
        new_out = row_price.get("out")
        if new_in is None and new_out is None:
            continue
        before = (cur.get("in"), cur.get("out"))
        after = (new_in if new_in is not None else cur.get("in"),
                 new_out if new_out is not None else cur.get("out"))
        if before != after:
            pricing[key] = {"in": after[0], "out": after[1]}
            updated.append({"key": key, "before": before, "after": after})
    # ensure ledger-known primary ids exist
    for primary in (
        "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
        "gpt-5.3-codex-spark", "grok-4.5", "grok-4.3", "claude-opus-4-8",
        "claude-sonnet", "claude-haiku", "claude-fable-5",
    ):
        row = lookup_row(primary)
        if not row or row.get("usd_per_1m_input") is None:
            continue
        if primary not in pricing:
            pricing[primary] = {
                "in": row.get("usd_per_1m_input"),
                "out": row.get("usd_per_1m_output"),
            }
            updated.append({"key": primary, "before": None,
                            "after": (row.get("usd_per_1m_input"), row.get("usd_per_1m_output"))})
    cfg["pricing"] = pricing
    cfg["_pricing_comment"] = (
        "NOTIONAL API list prices USD per MILLION tokens {in,out} for costreport + "
        "score-per-weight (TSMC-20229). Canonical rows: benchmark/price_ledger.json "
        f"(as_of {load_ledger().get('as_of')}). Weight = in/2.50. Subscription lanes "
        "still have ~0 marginal $; input_weight is the live pool-draw proxy."
    )
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
    return {"path": str(cfg_path), "updated": updated, "pricing_keys": len(pricing)}


def summary_table(data: dict | None = None) -> str:
    data = data or load_ledger()
    lines = [
        f"Price ledger as_of={data.get('as_of')}  anchor=${data.get('anchor', {}).get('usd_per_1m_input', ANCHOR_USD)}/1M",
        f"{'id':<22} {'in':>8} {'out':>8} {'w':>6}  status",
        "-" * 64,
    ]
    for row in data.get("rows") or []:
        inn = row.get("usd_per_1m_input")
        out = row.get("usd_per_1m_output")
        w = row.get("input_weight")
        lines.append(
            f"{str(row.get('id')):<22} "
            f"{('-' if inn is None else f'{inn:.2f}'):>8} "
            f"{('-' if out is None else f'{out:.2f}'):>8} "
            f"{('-' if w is None else f'{w:.2f}'):>6}  "
            f"{row.get('status')}"
        )
    return "\n".join(lines)


def selftest() -> int:
    data = reload_ledger()
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # operator punchline: Luna 0.08, Terra 0.80, Sol/5.5 = 2.0, 5.4 = 1.0
    check(input_weight("gpt-5.6-luna") == 0.08, "luna weight")
    check(input_weight("gpt-5.6-terra") == 0.80, "terra weight")
    check(input_weight("gpt-5.6-sol") == 2.0, "sol weight")
    check(input_weight("gpt-5.5") == 2.0, "gpt-5.5 weight")
    check(input_weight("gpt-5.4") == 1.0, "gpt-5.4 weight")
    check(input_weight("gpt-5.3-codex-spark") == 0.1, "spark weight")
    check(input_weight("grok-4.5") == 0.8, "grok-4.5 weight")
    check(input_weight("grok-4.3") == 0.5, "grok-4.3 weight")
    check(input_weight("claude-opus") == 2.0, "opus alias")
    check(input_weight("claude-sonnet-5") is None, "sonnet-5 awaiting")
    check(input_weight("claude-opus-5") is None, "opus-5 awaiting")

    # score-per-weight: 0.95 @ 0.4 beats 0.98 @ 2.0
    a = score_per_weight(0.95, "claude-haiku")  # 0.4
    b = score_per_weight(0.98, "claude-opus-4.8")  # 2.0
    check(a is not None and b is not None and a > b, "0.95/0.4 > 0.98/2.0")

    # fortnight punchline: 749M gpt-5.5 → 1.498B terra-eq
    wb = weighted_tokens(749_000_000, "gpt-5.5")
    check(wb is not None and abs(wb - 1_498_000_000) < 1, f"749M*2.0 weighted={wb}")

    # long-context overlay
    check(input_weight("grok-4.3", input_tokens=50_000) == 0.5, "grok short")
    check(input_weight("grok-4.3", input_tokens=250_000) == 1.0, "grok long")

    # alias resolution from usage-like strings
    check(lookup_row("Codex GPT-5.5") is not None or lookup_row("gpt-5.5") is not None, "lookup gpt-5.5")
    check(input_weight("hermes-grok-4.5") == 0.8, "hermes-grok-4.5 alias")

    if failures:
        print("SELFTEST FAIL:")
        for f in failures:
            print(" -", f)
        return 1
    print("SELFTEST OK")
    print(summary_table(data))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="public model price ledger / score-per-weight helpers")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("summary", help="print ledger table")
    p_lookup = sub.add_parser("lookup", help="resolve a model id/alias")
    p_lookup.add_argument("model")
    p_w = sub.add_parser("weighted-burn", help="tokens × weight")
    p_w.add_argument("--model", required=True)
    p_w.add_argument("--input", type=float, required=True, dest="input_tokens")
    p_w.add_argument("--output", type=float, default=0.0, dest="output_tokens")
    sub.add_parser("selftest")
    p_sync = sub.add_parser("sync-config", help="write ledger prices into config.pricing")
    p_sync.add_argument("--config", default=None)

    args = ap.parse_args(argv)
    if args.cmd == "summary":
        print(summary_table())
        return 0
    if args.cmd == "lookup":
        row = lookup_row(args.model)
        if not row:
            print(f"no row for {args.model!r}")
            return 1
        print(json.dumps(row, indent=2))
        print(f"resolved_input_weight={input_weight(args.model)}")
        return 0
    if args.cmd == "weighted-burn":
        wi = weighted_tokens(args.input_tokens, args.model)
        wo = weighted_tokens(args.output_tokens, args.model, input_tokens_for_context=args.input_tokens)
        print(json.dumps({
            "model": args.model,
            "input_weight": input_weight(args.model, input_tokens=args.input_tokens),
            "raw_input": args.input_tokens,
            "raw_output": args.output_tokens,
            "weighted_input_terra_eq": wi,
            "weighted_output_terra_eq": wo,
        }, indent=2))
        return 0
    if args.cmd == "selftest":
        return selftest()
    if args.cmd == "sync-config":
        result = sync_config_pricing(Path(args.config) if args.config else None)
        print(json.dumps(result, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
