#!/usr/bin/env python3
"""Build the unified local data inventory registry (E5, report-only).

Scans the two local market-data tiers and writes one registry artifact that
every pod MUST consult before requesting new or paid data:

- OHLCV parquet cache under ``/root/.cps/data`` — ``*.parquet`` files with
  ``.meta.json`` sidecars (``{dataset, schema, symbol, start, end, ...}``).
  The richer in-repo API for this tier is ``cps.data.inventory.scan_cache()``;
  this script parses the same sidecars with stdlib only so it can run from
  cron without the cps virtualenv.
- Tick/L2 recorder tree under ``/root/cli/micro-addon/data`` — live recorder
  output as ``<date>/<HH>/<stream>-<SYMBOL>.jsonl[.gz]``, one subtree per
  venue (hyperliquid at the top level for historical reasons).

Output: ``/root/cps/var/data_inventory/INVENTORY.json`` (+ ``INVENTORY.md``
summary). Also contains a *curated* subscription map (which paid
subscriptions unlock which paper families, with direct links) and the
inventory-first rule text. Curated sections are marked ``"curated": true`` —
they are maintained by hand here, not derived from disk.

The script only *reads* market-data paths and *writes* the registry artifact.
It never calls a network API, never spends money, never touches broker state.
"""
from __future__ import annotations

import argparse
import gzip  # noqa: F401  (documents the .gz tier; files are never decompressed here)
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REGISTRY_SCHEMA = "fincli.data_inventory.v1"
DEFAULT_OHLCV_ROOT = Path("/root/.cps/data")
DEFAULT_TICK_ROOT = Path("/root/cli/micro-addon/data")
DEFAULT_OUT_DIR = Path("/root/cps/var/data_inventory")

DATE_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TICK_FILE_RE = re.compile(r"^(?P<stream>[A-Za-z0-9]+)-(?P<symbol>[A-Z0-9]+)\.jsonl(\.gz)?$")

# Venue subdirs of the tick root. Hyperliquid's recorder predates the venue
# layout and writes dated dirs directly at the root.
TICK_VENUE_DIRS = ("binance", "coinbase", "ibkr", "icmarkets")
TICK_TOP_LEVEL_VENUE = "hyperliquid"

FRESH_TICK_SECONDS = 2 * 3600        # a live recorder writes the current hour
FRESH_OHLCV_SECONDS = 3 * 24 * 3600  # rolling bar caches refresh daily-ish

# --- curated: subscription map + inventory-first rule -----------------------
# Maintained by hand. Update when the operator subscribes / unsubscribes.
SUBSCRIPTION_MAP = [
    {
        "provider": "IBKR",
        "subscription": "CME Real-Time (NP,L2) / futures market-data bundle",
        "status": "have",
        "unlocks": "ES/NQ/6E/BTC/MBT tick recording (live now via micro-addon ibkr recorder)",
        "link": "https://www.interactivebrokers.com/en/pricing/research-news-marketdata.php",
    },
    {
        "provider": "IBKR",
        "subscription": "US Equity and Options Add-On",
        "status": "missing",
        "unlocks": "US options paper families (e.g. SPY options history pulls)",
        "link": "https://www.interactivebrokers.com/en/pricing/research-news-marketdata.php",
    },
    {
        "provider": "Alpaca",
        "subscription": "account signup (free tier)",
        "status": "missing",
        "unlocks": "US equities bars/trades for equity paper families",
        "link": "https://alpaca.markets",
    },
    {
        "provider": "Databento",
        "subscription": "pay-per-download GLBX.MDP3 (no standing subscription)",
        "status": "have",
        "unlocks": "CME futures history top-ups (ES/CL/NG/SI/6E continuous); paid per pull — requires allowPaidData",
        "link": "https://databento.com",
    },
    {
        "provider": "IC Markets",
        "subscription": "FIX API (existing account)",
        "status": "have",
        "unlocks": "EURUSD/GBPUSD/USDJPY/AUDUSD forex BBO recording (live now)",
        "link": "https://www.icmarkets.com",
    },
]

INVENTORY_FIRST_RULE = (
    "Pods MUST consult this registry before requesting new or paid data. "
    "If the need is covered by a source listed here, use the local path. "
    "If not covered, file a data_check blocker (kind=data_subscription, "
    "human_required=true) with a simple-language ask and a direct link, and "
    "wait — never spend on data without explicit allowPaidData."
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iso_from_ts(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# --- tier 1: OHLCV parquet cache --------------------------------------------

def scan_ohlcv_cache(root: Path) -> list[dict[str, Any]]:
    """One entry per (dataset, schema, symbol): range union + file stats."""
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    if not root.is_dir():
        return []
    for parquet in sorted(root.rglob("*.parquet")):
        sidecar = parquet.with_name(parquet.name + ".meta.json")
        if not sidecar.exists():
            continue  # same skip rule as cps.data.inventory.scan_cache
        try:
            meta = json.loads(sidecar.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        dataset = str(meta.get("dataset") or parquet.parent.name)
        schema = str(meta.get("schema") or "unknown")
        symbol = str(meta.get("symbol") or "unknown")
        start = meta.get("start")
        end = meta.get("end")
        try:
            stat = parquet.stat()
        except OSError:
            continue
        key = (dataset, schema, symbol)
        g = groups.setdefault(key, {
            "tier": "ohlcv_cache",
            "dataset": dataset,
            "schema": schema,
            "symbol": symbol,
            "start": start,
            "end": end,
            "files": 0,
            "bytes": 0,
            "newest_mtime_utc": iso_from_ts(stat.st_mtime),
            "_newest_mtime": stat.st_mtime,
            "path": str(parquet.parent),
        })
        g["files"] += 1
        g["bytes"] += stat.st_size
        if start and (g["start"] is None or str(start) < str(g["start"])):
            g["start"] = start
        if end and (g["end"] is None or str(end) > str(g["end"])):
            g["end"] = end
        if stat.st_mtime > g["_newest_mtime"]:
            g["_newest_mtime"] = stat.st_mtime
            g["newest_mtime_utc"] = iso_from_ts(stat.st_mtime)
    now = datetime.now(timezone.utc).timestamp()
    out = []
    for g in groups.values():
        g["fresh"] = (now - g.pop("_newest_mtime")) < FRESH_OHLCV_SECONDS
        out.append(g)
    out.sort(key=lambda g: (g["dataset"], g["schema"], g["symbol"]))
    return out


# --- tier 2: tick/L2 recorder tree ------------------------------------------

def _scan_tick_venue(venue: str, dated_dirs: list[Path]) -> dict[str, Any] | None:
    symbols: set[str] = set()
    streams: set[str] = set()
    total_bytes = 0
    files = 0
    newest_mtime = 0.0
    dates = sorted(d.name for d in dated_dirs)
    for day_dir in dated_dirs:
        try:
            hour_dirs = [h for h in day_dir.iterdir() if h.is_dir()]
        except OSError:
            continue
        for hour_dir in hour_dirs:
            try:
                entries = list(hour_dir.iterdir())
            except OSError:
                continue
            for f in entries:
                m = TICK_FILE_RE.match(f.name)
                if not m:
                    continue
                try:
                    stat = f.stat()
                except OSError:
                    continue
                files += 1
                total_bytes += stat.st_size
                symbols.add(m.group("symbol"))
                streams.add(m.group("stream"))
                if stat.st_mtime > newest_mtime:
                    newest_mtime = stat.st_mtime
    if not files:
        return None
    now = datetime.now(timezone.utc).timestamp()
    return {
        "tier": "tick_recorders",
        "venue": venue,
        "symbols": sorted(symbols),
        "streams": sorted(streams),
        "earliest_date": dates[0] if dates else None,
        "latest_date": dates[-1] if dates else None,
        "days": len(dates),
        "files": files,
        "bytes": total_bytes,
        "newest_mtime_utc": iso_from_ts(newest_mtime),
        "live": (now - newest_mtime) < FRESH_TICK_SECONDS,
    }


def scan_tick_recorders(root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    top_dated: list[Path] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if DATE_DIR_RE.match(child.name):
            top_dated.append(child)
        elif child.name in TICK_VENUE_DIRS:
            dated = [d for d in child.iterdir() if d.is_dir() and DATE_DIR_RE.match(d.name)]
            entry = _scan_tick_venue(child.name, sorted(dated))
            if entry:
                entry["path"] = str(child)
                out.append(entry)
    if top_dated:
        entry = _scan_tick_venue(TICK_TOP_LEVEL_VENUE, top_dated)
        if entry:
            entry["path"] = str(root)
            out.append(entry)
    out.sort(key=lambda e: e["venue"])
    return out


# --- assembly ----------------------------------------------------------------

def build_registry(ohlcv_root: Path, tick_root: Path) -> dict[str, Any]:
    ohlcv = scan_ohlcv_cache(ohlcv_root)
    ticks = scan_tick_recorders(tick_root)
    stale = [f'{g["dataset"]}/{g["schema"]}/{g["symbol"]}' for g in ohlcv if not g["fresh"]]
    stale += [t["venue"] for t in ticks if not t["live"]]
    return {
        "schema": REGISTRY_SCHEMA,
        "generated_utc": utc_now(),
        "generated_by": "build-data-inventory.v1",
        "inventory_first_rule": INVENTORY_FIRST_RULE,
        "safety": {
            "network": False,
            "paid_actions": False,
            "broker_actions": False,
            "writes_outside_registry": False,
        },
        "tiers": {
            "ohlcv_cache": {"root": str(ohlcv_root), "sources": ohlcv},
            "tick_recorders": {"root": str(tick_root), "venues": ticks},
        },
        "summary": {
            "ohlcv_sources": len(ohlcv),
            "tick_venues": len(ticks),
            "live_tick_venues": sum(1 for t in ticks if t["live"]),
            "total_bytes": sum(g["bytes"] for g in ohlcv) + sum(t["bytes"] for t in ticks),
            "stale_sources": stale,
        },
        "subscription_map": {"curated": True, "entries": SUBSCRIPTION_MAP},
    }


def human_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024
    return f"{n}B"


def write_markdown(path: Path, reg: dict[str, Any]) -> None:
    lines = [
        "# Local data inventory",
        "",
        f"Generated: {reg['generated_utc']} — schema `{reg['schema']}`",
        "",
        f"> **Inventory-first rule:** {reg['inventory_first_rule']}",
        "",
        "## Tick/L2 recorders (live microstructure tier)",
        "",
        "| Venue | Symbols | Streams | Range | Size | Live |",
        "|---|---|---|---|---|---|",
    ]
    for t in reg["tiers"]["tick_recorders"]["venues"]:
        lines.append(
            f"| {t['venue']} | {', '.join(t['symbols'])} | {', '.join(t['streams'])} "
            f"| {t['earliest_date']} → {t['latest_date']} ({t['days']}d) "
            f"| {human_bytes(t['bytes'])} | {'✅' if t['live'] else '⚠ stale'} |"
        )
    lines += [
        "",
        "## OHLCV parquet cache",
        "",
        "| Dataset | Schema | Symbol | Range | Files | Size | Fresh |",
        "|---|---|---|---|---|---|---|",
    ]
    for g in reg["tiers"]["ohlcv_cache"]["sources"]:
        lines.append(
            f"| {g['dataset']} | {g['schema']} | {g['symbol']} "
            f"| {str(g['start'])[:10]} → {str(g['end'])[:10]} "
            f"| {g['files']} | {human_bytes(g['bytes'])} | {'✅' if g['fresh'] else '⚠'} |"
        )
    lines += ["", "## Subscription map (curated)", ""]
    for s in reg["subscription_map"]["entries"]:
        mark = "✅ have" if s["status"] == "have" else "❌ missing"
        lines.append(f"- **{s['provider']} — {s['subscription']}** ({mark}): {s['unlocks']} — [{s['link']}]({s['link']})")
    lines.append("")
    path.write_text("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ohlcv-root", default=str(DEFAULT_OHLCV_ROOT))
    parser.add_argument("--tick-root", default=str(DEFAULT_TICK_ROOT))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    reg = build_registry(Path(args.ohlcv_root), Path(args.tick_root))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "INVENTORY.json").write_text(json.dumps(reg, indent=2, sort_keys=True) + "\n")
    write_markdown(out_dir / "INVENTORY.md", reg)
    print(json.dumps({
        "status": "ok",
        "out": str(out_dir / "INVENTORY.json"),
        "ohlcv_sources": reg["summary"]["ohlcv_sources"],
        "tick_venues": reg["summary"]["tick_venues"],
        "live_tick_venues": reg["summary"]["live_tick_venues"],
        "total_bytes": reg["summary"]["total_bytes"],
        "stale_sources": reg["summary"]["stale_sources"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
