#!/usr/bin/env python3
"""Build the queryable tool catalog for pods (E7, report-only).

Merges what already exists on disk into one catalog artifact so pods consult
it during the E2 inventory stage instead of rediscovering tools:

- python research environments — ``/root/cps/var/toolbelt/*/READINESS.json``
  (``cps.research_toolbelt_readiness.v1`` / ``cps.tinker_readiness.v1``)
- tick recorders — the E5 data-inventory registry's ``tick_recorders`` tier
- the NautilusTrader execution plane — latest ``nautilus-spike-*`` readiness
  report under self_practice (production pin, adapters, spool/intake)
- local paper-broker services — listen-state read from ``/proc/net/tcp`` only
- curated engine/adapter entries with on-disk anchors (marked
  ``"curated": true``; anchors are verified paths, claims beyond that are not
  machine-checked)

Output: ``/root/cps/var/toolbelt/CATALOG.json`` (+ ``CATALOG.md``). The script
reads local files only — no network, no spend, no broker actions. Missing
tools become install tasks or operator asks; nothing is installed here.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CATALOG_SCHEMA = "fincli.tool_catalog.v1"
DEFAULT_TOOLBELT_DIR = Path("/root/cps/var/toolbelt")
DEFAULT_INVENTORY_FILE = Path("/root/cps/var/data_inventory/INVENTORY.json")
DEFAULT_SELF_PRACTICE_DIR = Path("/root/cps/var/self_practice")

# Local paper-broker services (loopback listeners; state read from /proc only).
SERVICE_PORTS = {
    "hl-paper-broker-8090": 8090,
    "hl-paper-broker-8091": 8091,
}

# Curated entries. Anchors are re-verified on every run (path exists / port
# listening); descriptions beyond the anchor are maintained by hand.
CURATED_ENGINES = [
    {
        "name": "cps-evolve",
        "kind": "engine",
        "anchor": "/root/cps/src/cps/evolution",
        "notes": "CPS evolutionary strategy search (evolve.run); OOS fitness via CPS_EVOLVE_OOS_FITNESS=1.",
    },
    {
        "name": "microbt",
        "kind": "engine",
        "anchor": "/root/cli/micro-addon/pipeline/microbt.py",
        "notes": "Micro-addon tick/bar backtester used by the micro research loop.",
    },
]

CURATED_ADAPTERS = [
    {
        "name": "tradier-nautilus",
        "kind": "broker_adapter",
        "anchor": "/root/tradier-nautilus",
        "notes": "Tradier NautilusTrader adapter (equities+options), published as Curious-LTD/tradier-nautilus.",
    },
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def listening_ports() -> set[int]:
    """Loopback/any listeners from /proc/net/tcp{,6} (file read only)."""
    ports: set[int] = set()
    for proc in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(proc).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 4 or parts[3] != "0A":  # 0A = LISTEN
                continue
            try:
                ports.add(int(parts[1].rsplit(":", 1)[1], 16))
            except (ValueError, IndexError):
                continue
    return ports


def scan_environments(toolbelt_dir: Path) -> list[dict[str, Any]]:
    envs: list[dict[str, Any]] = []
    if not toolbelt_dir.is_dir():
        return envs
    for readiness_path in sorted(toolbelt_dir.glob("*/READINESS.json")):
        data = load_json(readiness_path)
        if not data:
            continue
        name = str(data.get("name") or readiness_path.parent.name)
        schema = str(data.get("schema") or "unknown")
        summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
        ready_keys = [k for k in summary if str(k).startswith("ready_for_")]
        ready = bool(summary[ready_keys[0]]) if ready_keys else None
        status = data.get("status")
        entry: dict[str, Any] = {
            "name": name,
            "kind": "service" if schema.startswith("cps.tinker") else "python_environment",
            "schema": schema,
            "readiness_path": str(readiness_path),
            "generated_utc": data.get("generated_utc") or data.get("checked_utc"),
            "ready": ready if ready is not None else (status == "ready"),
            "status": status,
            "tool_count": summary.get("tool_count"),
            "import_ok": summary.get("import_ok"),
            "failed_imports": (data.get("failed_imports") or [])[:10],
        }
        envs.append(entry)
    return envs


def scan_recorders(inventory_file: Path) -> list[dict[str, Any]]:
    reg = load_json(inventory_file)
    if not reg or not str(reg.get("schema", "")).startswith("fincli.data_inventory."):
        return []
    venues = ((reg.get("tiers") or {}).get("tick_recorders") or {}).get("venues") or []
    return [
        {
            "name": f"{v.get('venue')}-recorder",
            "kind": "recorder",
            "venue": v.get("venue"),
            "symbols": v.get("symbols") or [],
            "streams": v.get("streams") or [],
            "live": v.get("live") is True,
            "path": v.get("path"),
        }
        for v in venues
        if isinstance(v, dict)
    ]


def scan_execution_plane(self_practice_dir: Path) -> dict[str, Any] | None:
    reports = sorted(self_practice_dir.glob("nautilus-spike-*/NAUTILUS_*_TEST_REPORT.json"))
    if not reports:
        return None
    latest = reports[-1]
    data = load_json(latest)
    if not data:
        return None
    readiness = data.get("readiness") if isinstance(data.get("readiness"), dict) else {}
    return {
        "name": "nautilus-execution-plane",
        "kind": "engine",
        "production_pin": data.get("production_pin"),
        "candidate_pin": data.get("candidate_pin"),
        "production_root": data.get("production_root_untouched"),
        "status": readiness.get("status"),
        "capabilities": readiness.get("capabilities") or {},
        "report_path": str(latest),
        "report_generated_utc": data.get("generated_utc"),
    }


def scan_services() -> list[dict[str, Any]]:
    ports = listening_ports()
    return [
        {
            "name": name,
            "kind": "service",
            "port": port,
            "listening": port in ports,
            "notes": "local paper-broker HTTP service (loopback only)",
        }
        for name, port in SERVICE_PORTS.items()
    ]


def curated_with_anchors(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for entry in entries:
        anchor = Path(entry["anchor"])
        out.append({**entry, "curated": True, "anchor_present": anchor.exists()})
    return out


def build_catalog(toolbelt_dir: Path, inventory_file: Path, self_practice_dir: Path) -> dict[str, Any]:
    environments = scan_environments(toolbelt_dir)
    recorders = scan_recorders(inventory_file)
    execution = scan_execution_plane(self_practice_dir)
    services = scan_services()
    engines = curated_with_anchors(CURATED_ENGINES)
    adapters = curated_with_anchors(CURATED_ADAPTERS)
    missing = [e["name"] for e in environments if e.get("ready") is False]
    missing += [s["name"] for s in services if not s["listening"]]
    missing += [e["name"] for e in engines + adapters if not e["anchor_present"]]
    return {
        "schema": CATALOG_SCHEMA,
        "generated_utc": utc_now(),
        "generated_by": "build-tool-catalog.v1",
        "purpose": (
            "Pods consult this catalog during the inventory stage instead of "
            "rediscovering tools. A missing/unready tool becomes an install task "
            "or an operator ask — never an ad-hoc install inside a research run."
        ),
        "safety": {
            "network": False,
            "paid_actions": False,
            "broker_actions": False,
            "installs_anything": False,
        },
        "data_inventory_ref": str(inventory_file),
        "sections": {
            "python_environments": environments,
            "recorders": recorders,
            "execution_plane": execution,
            "services": services,
            "engines": engines,
            "broker_adapters": adapters,
        },
        "summary": {
            "environments": len(environments),
            "ready_environments": sum(1 for e in environments if e.get("ready")),
            "recorders_live": sum(1 for r in recorders if r["live"]),
            "recorders_total": len(recorders),
            "services_listening": sum(1 for s in services if s["listening"]),
            "not_ready": missing,
        },
    }


def write_markdown(path: Path, cat: dict[str, Any]) -> None:
    s = cat["sections"]
    lines = [
        "# Tool catalog",
        "",
        f"Generated: {cat['generated_utc']} — schema `{cat['schema']}`",
        "",
        f"> {cat['purpose']}",
        "",
        "## Python research environments",
        "",
        "| Env | Ready | Tools OK | Failures |",
        "|---|---|---|---|",
    ]
    for e in s["python_environments"]:
        ready = "✅" if e.get("ready") else ("⚠ " + str(e.get("status") or "not ready"))
        lines.append(f"| {e['name']} | {ready} | {e.get('import_ok')}/{e.get('tool_count')} | {', '.join(e.get('failed_imports') or []) or '—'} |")
    lines += ["", "## Recorders", "", "| Recorder | Symbols | Live |", "|---|---|---|"]
    for r in s["recorders"]:
        lines.append(f"| {r['name']} | {', '.join(r['symbols'])} | {'✅' if r['live'] else '⚠ stale'} |")
    ex = s["execution_plane"]
    lines += ["", "## Execution plane", ""]
    if ex:
        caps = ", ".join(k for k, v in (ex.get("capabilities") or {}).items() if v)
        lines.append(f"- **{ex['name']}** — NautilusTrader pin {ex.get('production_pin')} at `{ex.get('production_root')}`, status {ex.get('status')} ({ex.get('report_generated_utc')}). Capabilities: {caps}")
    else:
        lines.append("- no execution-plane readiness report found")
    lines += ["", "## Services", ""]
    for svc in s["services"]:
        lines.append(f"- {svc['name']} (port {svc['port']}): {'listening' if svc['listening'] else '⚠ down'}")
    lines += ["", "## Engines & adapters (curated anchors)", ""]
    for e in s["engines"] + s["broker_adapters"]:
        mark = "✅" if e["anchor_present"] else "❌ missing"
        lines.append(f"- **{e['name']}** ({e['kind']}, {mark}): `{e['anchor']}` — {e['notes']}")
    lines.append("")
    path.write_text("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--toolbelt-dir", default=str(DEFAULT_TOOLBELT_DIR))
    parser.add_argument("--inventory-file", default=str(DEFAULT_INVENTORY_FILE))
    parser.add_argument("--self-practice-dir", default=str(DEFAULT_SELF_PRACTICE_DIR))
    parser.add_argument("--out-dir", default=None, help="default: --toolbelt-dir")
    args = parser.parse_args()

    toolbelt_dir = Path(args.toolbelt_dir)
    cat = build_catalog(toolbelt_dir, Path(args.inventory_file), Path(args.self_practice_dir))
    out_dir = Path(args.out_dir) if args.out_dir else toolbelt_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "CATALOG.json").write_text(json.dumps(cat, indent=2, sort_keys=True) + "\n")
    write_markdown(out_dir / "CATALOG.md", cat)
    print(json.dumps({"status": "ok", "out": str(out_dir / "CATALOG.json"), **cat["summary"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
