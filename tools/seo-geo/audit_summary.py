#!/usr/bin/env python3
"""Audit-Summary fuer die woechentliche SEO/GEO-Audit-Routine.

Liest die frischen ``report.json`` aller Sites aus ``sites.json``, zaehlt die
Findings (gesamt / nach Severity / nach Feld), schreibt eine **datierte
History-Datei** (leichtgewichtiges Monitoring — echtes Diff/Alerting ist
Task 5b) und gibt einen Markdown-Ampelbericht auf stdout aus, den
``audit-all.sh`` per Mailhub an Walter schickt.

Kein LLM, rein deterministisch. Python 3.11+ (venv), NICHT System-python3.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
from collections import Counter

_SNAP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")


def _load_sites(path: str) -> tuple[str, list[dict]]:
    data = json.loads(open(os.path.expanduser(path)).read())
    return data.get("report_root", "~/.paperclip/seo-geo"), data.get("sites", [])


def _count(report: dict) -> dict:
    findings = report.get("findings", []) or []
    by_sev = Counter(f.get("severity", "?") for f in findings)
    by_field = Counter(f.get("field", "?") for f in findings)
    return {
        "total": len(findings),
        "pages": len(report.get("pages", []) or []),
        "high": by_sev.get("high", 0),
        "medium": by_sev.get("medium", 0),
        "low": by_sev.get("low", 0),
        "by_field": dict(by_field),
        "findings": findings,
    }


def _ampel(high: int, total: int) -> str:
    if high == 0 and total == 0:
        return "\U0001F7E2"  # gruen
    if high == 0:
        return "\U0001F7E1"  # gelb
    return "\U0001F534"  # rot


def collect(sites_path: str) -> dict:
    report_root, sites = _load_sites(sites_path)
    root = os.path.expanduser(report_root)
    out: dict[str, dict] = {}
    for site in sites:
        name = site["name"]
        jpath = os.path.join(root, name, "report.json")
        if not os.path.exists(jpath):
            out[name] = {"error": "kein report.json (Audit fehlgeschlagen?)"}
            continue
        try:
            out[name] = _count(json.loads(open(jpath).read()))
        except Exception as exc:  # noqa: BLE001
            out[name] = {"error": f"report.json unlesbar: {exc}"}
    return out


def _dated_snapshots(hist_dir: str) -> list[tuple[str, dict]]:
    if not os.path.isdir(hist_dir):
        return []
    out = []
    for fn in sorted(os.listdir(hist_dir)):
        m = _SNAP_RE.match(fn)
        if not m:
            continue
        try:
            out.append((m.group(1), json.loads(open(os.path.join(hist_dir, fn)).read())))
        except Exception:  # noqa: BLE001 — defekte Datei überspringen
            continue
    return out


def _prev_snapshot(hist_dir: str, today: str) -> dict | None:
    older = [d for d in _dated_snapshots(hist_dir) if d[0] < today]
    return older[-1][1] if older else None


def _delta(cur: int, prev: dict | None, name: str) -> str:
    if not prev or name not in prev or "total" not in prev.get(name, {}):
        return ""
    d = cur - prev[name]["total"]
    if d == 0:
        return " (±0)"
    return f" ({'+' if d > 0 else ''}{d} vs. Vorwoche)"


def render(counts: dict, report_root: str, today: str) -> str:
    hist_dir = os.path.join(os.path.expanduser(report_root), "_audit-history")
    prev = _prev_snapshot(hist_dir, today)

    lines = [f"# SEO/GEO Wochen-Audit — {today}", ""]
    lines.append("| Site | Ampel | Findings | high | medium | low |")
    lines.append("|------|-------|----------|------|--------|-----|")
    for name, c in counts.items():
        if "error" in c:
            lines.append(f"| {name} | ⚠️ | {c['error']} | | | |")
            continue
        amp = _ampel(c["high"], c["total"])
        dlt = _delta(c["total"], prev, name)
        lines.append(
            f"| {name} | {amp} | {c['total']}{dlt} | {c['high']} | {c['medium']} | {c['low']} |"
        )
    lines.append("")

    # Detail je Site nach Feld
    for name, c in counts.items():
        if "error" in c:
            continue
        if not c["by_field"]:
            lines.append(f"**{name}** — keine Findings \U0001F7E2")
            continue
        fld = ", ".join(f"{k}: {v}" for k, v in sorted(c["by_field"].items()))
        lines.append(f"**{name}** ({c['pages']} Seiten) — {fld}")
    lines.append("")
    lines.append(
        "_Ampel: \U0001F7E2 sauber · \U0001F7E1 nur medium/low · \U0001F534 high vorhanden. "
        "Deterministisches Onpage-Audit (Titel/Description/H1/Alt/Schema). "
        "Diff/Alerting-Ausbau = Task 5b._"
    )
    return "\n".join(lines) + "\n"


def gsc_section(sites_path: str, environ: dict, today: datetime.date) -> tuple[str, str, list[dict]]:
    """Fail-soft: fehlt der SA-Key oder scheitert alles, wird die Onpage-Mail nie gekippt.
    Rueckgabe: (markdown, overall_ampel, blocks)."""
    from config import load_sites
    key_file = environ.get("GSC_SA_KEY_FILE")
    if not key_file or not os.path.exists(os.path.expanduser(key_file)):
        return ("\n## Google Search Console\n\nGSC nicht konfiguriert "
                "(GSC_SA_KEY_FILE fehlt) — Onpage-Audit unberührt.\n", "\U0001F7E2", [])
    try:
        import gsc
        import gsc_report
        session = gsc.build_authorized_session(os.path.expanduser(key_file))
        client = gsc.GSCClient(session)
        windows = gsc.report_windows(today)
        blocks = [gsc_report.build_site_block(s, client, windows) for s in load_sites(sites_path)]
        return gsc_report.render_markdown(blocks), gsc_report.overall_ampel(blocks), blocks
    except Exception as e:  # noqa: BLE001 — niemals die Mail kippen
        return (f"\n## Google Search Console\n\nGSC-Abruf global fehlgeschlagen ({e}).\n", "\U0001F7E2", [])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="audit-summary")
    ap.add_argument("--sites", default="sites.json")
    ap.add_argument("--out", help="Markdown-Body hierhin schreiben (statt stdout)")
    args = ap.parse_args(argv)

    report_root, _ = _load_sites(args.sites)
    today_date = datetime.date.today()
    today = today_date.isoformat()
    counts = collect(args.sites)

    # History-Snapshot (datiert) schreiben — leichtgewichtiges Monitoring
    hist_dir = os.path.join(os.path.expanduser(report_root), "_audit-history")
    os.makedirs(hist_dir, exist_ok=True)
    with open(os.path.join(hist_dir, f"{today}.json"), "w") as fh:
        json.dump(counts, fh, ensure_ascii=False, indent=2)

    body = render(counts, report_root, today)

    gsc_md, gsc_amp, gsc_blocks = gsc_section(args.sites, os.environ, today_date)
    body = body + gsc_md
    if gsc_blocks:
        with open(os.path.join(hist_dir, f"{today}-gsc.json"), "w") as fh:
            json.dump(gsc_blocks, fh, ensure_ascii=False, indent=2)

    with open(os.path.join(hist_dir, f"{today}.md"), "w") as fh:
        fh.write(body)

    if args.out:
        with open(args.out, "w") as fh:
            fh.write(body)
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
