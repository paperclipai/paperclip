# Audit-Diff + Alerting (5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die wöchentliche SEO/GEO-Audit-Mail vergleicht Findings Woche-zu-Woche auf Finding-Ebene (neu/behoben/Regression) und schlägt bei Verschlechterung Alarm (⚠️-Betreff).

**Architecture:** Neues reines Modul `audit_diff.py` (Diff-/Alarm-Logik) im bestehenden `tools/seo-geo/`-Dienst; `audit_summary.py` speichert künftig die Findings im History-Snapshot und hängt eine Diff-Sektion + Alarm-Flag an; `audit-all.sh` setzt den Mail-Betreff aus dem Flag.

**Tech Stack:** Python 3.11 (venv), `pytest`. Keine neuen Abhängigkeiten.

## Global Constraints

- **Python 3.11+** (venv `tools/seo-geo/venv`; System-python3 3.9 bricht `str | None`). Tests mit `./venv/bin/python -m pytest`.
- **Deploy:** `rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/`.
- **Fail-soft:** Der Diff-Teil darf die bestehende Onpage- + GSC-Mail nie kippen. Erstlauf ohne Vorwoche, Alt-Snapshot ohne `findings`, defekte Datei, jede Exception → Sektion meldet das, Alarm-Flag `OK`, Rest läuft normal.
- **Finding-Schlüssel = `(url, field)`.** `issue`-Text (mit Zahlen) nur zur Anzeige, nie zum Matchen.
- **Alarm-Trigger (Alarm feuert bei JEDEM):** (1) neues `high`-Finding vs. Vorwoche; (2) Regression = neu vs. Vorwoche UND in einem älteren Snapshot vorhanden; (3) Netto-Anstieg `total` vs. Vorwoche; (4) GSC-Ampel der Site = 🔴 (aus 5a).
- **Snapshot-Dateien:** nur `^\d{4}-\d{2}-\d{2}\.json$` sind Onpage-Snapshots. `<date>-gsc.json` / `<date>-alert.txt` sind KEINE Snapshots und dürfen nicht als solche gelesen werden.
- **Betreff bei Alarm:** `⚠️ SEO/GEO Wochen-Audit <date> — Verschlechterung`, sonst `SEO/GEO Wochen-Audit <date>`.
- Commit-Messages enden mit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create `tools/seo-geo/audit_diff.py`** — reine Diff-/Alarm-Logik (kein IO).
- **Create `tools/seo-geo/test_audit_diff.py`** — Logik-Tests.
- **Modify `tools/seo-geo/audit_summary.py`** — `_count` liefert `findings`; strenger Snapshot-Loader `_dated_snapshots` + `_prev_snapshot`-Fix; `diff_section`; main-Wiring + Alarm-Flag.
- **Modify `tools/seo-geo/test_audit_summary.py`** — Snapshot-`findings`, strenges Matching, `diff_section` fail-soft.
- **Modify `tools/seo-geo/audit-all.sh`** — Betreff aus `<date>-alert.txt`.

**Reihenfolge:** 1 → 2 → 3 → 4 → 5.

---

### Task 1: `audit_summary.py` — Findings im Snapshot + strenger Snapshot-Loader

**Files:**
- Modify: `tools/seo-geo/audit_summary.py`
- Test: `tools/seo-geo/test_audit_summary.py`

**Interfaces:**
- Produces: `_count(report)` enthält zusätzlich `"findings": [...]` (Roh-Findings). `_dated_snapshots(hist_dir) -> list[tuple[str, dict]]` (nur `YYYY-MM-DD.json`, aufsteigend sortiert). `_prev_snapshot(hist_dir, today)` nutzt `_dated_snapshots` (ignoriert `-gsc.json`).

- [ ] **Step 1: Failing tests schreiben** — in `test_audit_summary.py` ergänzen:

```python
import json, datetime
from audit_summary import _count, _dated_snapshots, _prev_snapshot

def test_count_enthaelt_findings():
    rep = {"pages": [{}], "findings": [
        {"url": "https://a.de/", "field": "meta_description", "severity": "medium", "issue": "x"}]}
    c = _count(rep)
    assert c["total"] == 1
    assert c["findings"] == rep["findings"]

def test_dated_snapshots_ignoriert_gsc_und_alert(tmp_path):
    (tmp_path / "2026-07-11.json").write_text('{"a": {"total": 5}}')
    (tmp_path / "2026-07-11-gsc.json").write_text('[{"name": "a"}]')
    (tmp_path / "2026-07-18-alert.txt").write_text('OK')
    snaps = _dated_snapshots(str(tmp_path))
    assert [d for d, _ in snaps] == ["2026-07-11"]
    assert snaps[0][1] == {"a": {"total": 5}}

def test_prev_snapshot_nimmt_datei_nicht_gsc(tmp_path):
    (tmp_path / "2026-07-11.json").write_text('{"a": {"total": 5}}')
    (tmp_path / "2026-07-11-gsc.json").write_text('[{"name": "a"}]')
    prev = _prev_snapshot(str(tmp_path), "2026-07-18")
    assert prev == {"a": {"total": 5}}
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -k "findings or dated or prev_snapshot_nimmt" -v`
Expected: FAIL (`ImportError: cannot import name '_dated_snapshots'` bzw. `findings`-KeyError).

- [ ] **Step 3: Implementieren** — in `audit_summary.py`:

`_count` um `findings` erweitern (Zeile im Rückgabe-Dict ergänzen):

```python
    return {
        "total": len(findings),
        "pages": len(report.get("pages", []) or []),
        "high": by_sev.get("high", 0),
        "medium": by_sev.get("medium", 0),
        "low": by_sev.get("low", 0),
        "by_field": dict(by_field),
        "findings": findings,
    }
```

`_dated_snapshots` neu + `_prev_snapshot` darauf umstellen (ersetzt die bestehende `_prev_snapshot`):

```python
import re
_SNAP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")

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
```

(Die alte `_prev_snapshot`-Implementierung entfernen. `import re` oben zu den Imports.)

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -v`
Expected: PASS (neue + bestehende).

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/audit_summary.py tools/seo-geo/test_audit_summary.py
git commit -m "feat(seo-geo): Findings im Snapshot + strenger Snapshot-Loader (Diff-Basis)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `audit_diff.py` — Diff-/Alarm-Logik (rein)

**Files:**
- Create: `tools/seo-geo/audit_diff.py`
- Create: `tools/seo-geo/test_audit_diff.py`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `finding_key(f) -> tuple` = `(f.get("url"), f.get("field"))`.
  - `diff_findings(prev, cur) -> dict` = `{"new": [...], "resolved": [...]}` (Finding-Dicts).
  - `find_regressions(new_findings, older_findings_lists) -> list` (Teilmenge von `new_findings`, deren Key in irgendeiner älteren Liste vorkam).
  - `site_alerts(diff, regressions, prev_count, cur_count, gsc_ampel) -> list[str]`.
  - `any_alert(per_site) -> bool` (per_site = Liste von Dicts mit Key `alerts`).
  - `render_markdown(per_site) -> str`.

- [ ] **Step 1: Failing tests schreiben** — `test_audit_diff.py`:

```python
from audit_diff import (finding_key, diff_findings, find_regressions,
                        site_alerts, any_alert, render_markdown)

def _f(url, field, sev="medium", issue="x"):
    return {"url": url, "field": field, "severity": sev, "issue": issue}

def test_diff_new_und_resolved_nach_url_field():
    prev = [_f("a", "h1"), _f("a", "meta_description")]
    cur = [_f("a", "meta_description"), _f("b", "h1")]
    d = diff_findings(prev, cur)
    assert {finding_key(x) for x in d["new"]} == {("b", "h1")}
    assert {finding_key(x) for x in d["resolved"]} == {("a", "h1")}

def test_issue_textaenderung_ist_nicht_neu():
    prev = [_f("a", "meta_description", issue="Länge 282")]
    cur = [_f("a", "meta_description", issue="Länge 95")]
    d = diff_findings(prev, cur)
    assert d["new"] == [] and d["resolved"] == []

def test_find_regressions_nur_wenn_in_aelterem_snapshot():
    new = [_f("a", "h1"), _f("c", "alt_text")]
    older = [[_f("a", "h1")], [_f("x", "y")]]   # "a/h1" war mal da, "c/alt_text" nie
    reg = find_regressions(new, older)
    assert {finding_key(x) for x in reg} == {("a", "h1")}

def test_site_alerts_neues_high():
    d = {"new": [_f("a", "meta_description", sev="high")], "resolved": []}
    assert any("high" in a for a in site_alerts(d, [], 3, 3, "🟢"))

def test_site_alerts_regression():
    d = {"new": [], "resolved": []}
    assert any("Regression" in a for a in site_alerts(d, [_f("a", "h1")], 3, 3, "🟢"))

def test_site_alerts_netto_anstieg():
    d = {"new": [], "resolved": []}
    assert any("gestiegen" in a for a in site_alerts(d, [], 3, 5, "🟢"))

def test_site_alerts_gsc_rot():
    d = {"new": [], "resolved": []}
    assert any("GSC" in a for a in site_alerts(d, [], 3, 3, "🔴"))

def test_site_alerts_kein_alarm():
    d = {"new": [_f("a", "h1", sev="medium")], "resolved": []}
    assert site_alerts(d, [], 5, 3, "🟢") == []   # weniger Findings, kein high, keine Regression, GSC grün

def test_any_alert():
    assert any_alert([{"alerts": []}, {"alerts": ["x"]}]) is True
    assert any_alert([{"alerts": []}]) is False

def test_render_markdown_enthaelt_sitename_und_marker():
    md = render_markdown([{"name": "whitestag.ai", "new": [_f("a", "h1")],
                           "resolved": [_f("b", "meta_description")],
                           "regressions": [], "alerts": ["1 neues high-Finding"]}])
    assert "whitestag.ai" in md and "⚠️" in md
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_diff.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'audit_diff'`).

- [ ] **Step 3: `audit_diff.py` implementieren**

```python
"""Diff-/Alarm-Logik für das wöchentliche SEO/GEO-Audit. Rein: kein IO, kein Mail."""


def finding_key(f):
    return (f.get("url"), f.get("field"))


def diff_findings(prev, cur):
    pk = {finding_key(f): f for f in prev}
    ck = {finding_key(f): f for f in cur}
    new = [ck[k] for k in ck if k not in pk]
    resolved = [pk[k] for k in pk if k not in ck]
    return {"new": new, "resolved": resolved}


def find_regressions(new_findings, older_findings_lists):
    older_keys = set()
    for lst in older_findings_lists:
        older_keys |= {finding_key(f) for f in lst}
    return [f for f in new_findings if finding_key(f) in older_keys]


def site_alerts(diff, regressions, prev_count, cur_count, gsc_ampel):
    alerts = []
    new_high = [f for f in diff["new"] if f.get("severity") == "high"]
    if new_high:
        alerts.append(f"{len(new_high)} neues high-Finding")
    if regressions:
        alerts.append(f"{len(regressions)} Regression(en)")
    if prev_count is not None and cur_count > prev_count:
        alerts.append(f"Findings gestiegen ({prev_count}→{cur_count})")
    if gsc_ampel == "\U0001F534":  # 🔴
        alerts.append("GSC-Klick-Einbruch")
    return alerts


def any_alert(per_site):
    return any(s.get("alerts") for s in per_site)


def _fmt(findings):
    return ", ".join(f"{f.get('url')} [{f.get('field')}]" for f in findings)


def render_markdown(per_site):
    lines = ["", "## Veränderungen seit Vorwoche", ""]
    for s in per_site:
        marker = " ⚠️ " + "; ".join(s["alerts"]) if s.get("alerts") else ""
        lines.append(f"**{s['name']}**{marker}")
        if s.get("new"):
            lines.append(f"  - + neu ({len(s['new'])}): {_fmt(s['new'])}")
        if s.get("resolved"):
            lines.append(f"  - − behoben ({len(s['resolved'])}): {_fmt(s['resolved'])}")
        if s.get("regressions"):
            lines.append(f"  - ⚠️ Regression ({len(s['regressions'])}): {_fmt(s['regressions'])}")
        if not (s.get("new") or s.get("resolved") or s.get("regressions")):
            lines.append("  - keine Änderung")
    lines.append("")
    return "\n".join(lines)
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_diff.py -v`
Expected: PASS (11 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/audit_diff.py tools/seo-geo/test_audit_diff.py
git commit -m "feat(seo-geo): Audit-Diff/Alarm-Logik (neu/behoben/Regression + 4 Trigger)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `audit_summary.py` — `diff_section` + main-Wiring + Alarm-Flag

**Files:**
- Modify: `tools/seo-geo/audit_summary.py`
- Test: `tools/seo-geo/test_audit_summary.py`

**Interfaces:**
- Consumes: `audit_diff.*`, `_dated_snapshots`, `_count`-Findings, `gsc_blocks` (Liste mit `name`/`ampel`).
- Produces: `diff_section(cur_counts, gsc_blocks, hist_dir, today_str) -> tuple[str, bool]` (markdown, alert_flag); `main()` schreibt `<date>-alert.txt` = `ALERT|OK` und fügt die Diff-Sektion in den Body ein.

- [ ] **Step 1: Failing test schreiben** — `test_audit_summary.py`:

```python
from audit_summary import diff_section

def test_diff_section_erstlauf_ohne_basis(tmp_path):
    cur = {"a": {"total": 2, "high": 0, "findings": [
        {"url": "https://a.de/", "field": "h1", "severity": "medium", "issue": "x"}]}}
    md, alert = diff_section(cur, [], str(tmp_path), "2026-07-18")
    assert "keine Vergleichsbasis" in md
    assert alert is False

def test_diff_section_neues_high_alarmiert(tmp_path):
    (tmp_path / "2026-07-11.json").write_text(
        '{"a": {"total": 0, "high": 0, "findings": []}}')
    cur = {"a": {"total": 1, "high": 1, "findings": [
        {"url": "https://a.de/x", "field": "meta_description", "severity": "high", "issue": "fehlt"}]}}
    md, alert = diff_section(cur, [], str(tmp_path), "2026-07-18")
    assert alert is True
    assert "a" in md
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -k diff_section -v`
Expected: FAIL (`ImportError: cannot import name 'diff_section'`).

- [ ] **Step 3: `diff_section` implementieren + in `main()` verdrahten** — in `audit_summary.py`:

```python
def diff_section(cur_counts, gsc_blocks, hist_dir, today_str):
    """Fail-soft: Erstlauf/defekte History/Exception → Sektion meldet das, Flag False."""
    import audit_diff
    try:
        snaps = [d for d in _dated_snapshots(hist_dir) if d[0] < today_str]
        if not snaps:
            return ("\n## Veränderungen seit Vorwoche\n\n"
                    "keine Vergleichsbasis — Diff ab nächster Woche.\n", False)
        prev = snaps[-1][1]
        older_lists_by_site = {}
        for _, snap in snaps[:-1]:
            for name, entry in snap.items():
                if isinstance(entry, dict) and "findings" in entry:
                    older_lists_by_site.setdefault(name, []).append(entry["findings"])
        gsc_amp = {b.get("name"): b.get("ampel") for b in (gsc_blocks or [])}
        per_site = []
        for name, cur in cur_counts.items():
            if "error" in cur:
                continue
            cur_f = cur.get("findings", [])
            prev_entry = prev.get(name, {}) if isinstance(prev, dict) else {}
            prev_f = prev_entry.get("findings", []) if isinstance(prev_entry, dict) else []
            d = audit_diff.diff_findings(prev_f, cur_f)
            regs = audit_diff.find_regressions(d["new"], older_lists_by_site.get(name, []))
            prev_total = prev_entry.get("total") if isinstance(prev_entry, dict) else None
            alerts = audit_diff.site_alerts(d, regs, prev_total, cur.get("total", 0),
                                            gsc_amp.get(name, "\U0001F7E2"))
            per_site.append({"name": name, "new": d["new"], "resolved": d["resolved"],
                             "regressions": regs, "alerts": alerts})
        return audit_diff.render_markdown(per_site), audit_diff.any_alert(per_site)
    except Exception as e:  # noqa: BLE001 — niemals die Mail kippen
        return (f"\n## Veränderungen seit Vorwoche\n\nDiff fehlgeschlagen ({e}).\n", False)
```

In `main()`, NACH `body = render(...)` und VOR dem GSC-Block einfügen (so steht die Diff-Sektion zwischen Onpage-Tabelle und GSC):

```python
    diff_md, diff_alert = diff_section(counts, [], report_root and hist_dir or hist_dir, today)
    body = body + diff_md
    # (der GSC-Block folgt direkt danach)
```

WICHTIG: `diff_section` braucht die GSC-Ampeln, die erst nach `gsc_section` vorliegen. Deshalb die Reihenfolge in `main()` so:

```python
    body = render(counts, report_root, today)

    gsc_md, gsc_amp, gsc_blocks = gsc_section(args.sites, os.environ, today_date)
    diff_md, diff_alert = diff_section(counts, gsc_blocks, hist_dir, today)
    body = body + diff_md + gsc_md          # Diff zwischen Onpage und GSC

    if gsc_blocks:
        with open(os.path.join(hist_dir, f"{today}-gsc.json"), "w") as fh:
            json.dump(gsc_blocks, fh, ensure_ascii=False, indent=2)
    with open(os.path.join(hist_dir, f"{today}-alert.txt"), "w") as fh:
        fh.write("ALERT" if diff_alert else "OK")
```

(Die bestehende Snapshot-`<date>.json`-Schreibzeile bleibt davor; sie enthält durch Task 1 jetzt die Findings.)

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -v`
Expected: PASS.

- [ ] **Step 5: Gesamt-Suite**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest -q`
Expected: PASS (alle).

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/audit_summary.py tools/seo-geo/test_audit_summary.py
git commit -m "feat(seo-geo): Diff-Sektion + Alarm-Flag in die Wochen-Mail integriert

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `audit-all.sh` — Betreff aus Alarm-Flag

**Files:**
- Modify: `tools/seo-geo/audit-all.sh`

**Interfaces:**
- Consumes: `_audit-history/<date>-alert.txt` (`ALERT|OK`), von Task 3 geschrieben.

- [ ] **Step 1: Betreff-Logik einbauen** — in `audit-all.sh`, den Mail-Block (aktuell Betreff `"SEO/GEO Wochen-Audit $(date '+%F')"`) ersetzen durch:

```bash
DATE="$(date '+%F')"
ALERT_FILE="$HOME/.paperclip/seo-geo/_audit-history/${DATE}-alert.txt"
SUBJECT="SEO/GEO Wochen-Audit ${DATE}"
if [[ -f "$ALERT_FILE" ]] && [[ "$(cat "$ALERT_FILE")" == "ALERT" ]]; then
  SUBJECT="⚠️ SEO/GEO Wochen-Audit ${DATE} — Verschlechterung"
fi
if [[ -x "$SEND" ]]; then
  "$SEND" "$SUBJECT" "$BODY" && echo "Mail versendet ($SUBJECT)" || echo "WARN: Mailversand fehlgeschlagen"
else
  echo "WARN: send-walter-report.sh nicht gefunden — nur History geschrieben."
fi
```

(Die `report_root` ist `~/.paperclip/seo-geo`; die Flag-Datei liegt in dessen `_audit-history/`.)

- [ ] **Step 2: Syntax-Check**

Run: `bash -n tools/seo-geo/audit-all.sh && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add tools/seo-geo/audit-all.sh
git commit -m "feat(seo-geo): Mail-Betreff signalisiert Verschlechterung (Alarm-Flag)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Deploy + End-to-End-Verifikation

**Files:** keine (Deploy + Verifikation).

- [ ] **Step 1: Deploy**

Run:
```bash
cd "$(git rev-parse --show-toplevel)"
rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/
```
Expected: rsync ok.

- [ ] **Step 2: Diff gegen echten Vorwochen-Snapshot erzwingen (synthetisch)**

Es existiert nur ein Snapshot von heute. Für einen echten Diff-Test einen künstlichen „Vorwochen"-Snapshot bauen, der ein high-Finding weniger hat, dann Summary laufen lassen:

```bash
cd ~/.paperclip/scripts/seo-geo
PREV=~/.paperclip/seo-geo/_audit-history/2000-01-01.json
./venv/bin/python - <<'PY'
import json, os
cur = json.load(open(os.path.expanduser("~/.paperclip/seo-geo/_audit-history/%s.json" %
      sorted(f[:-5] for f in os.listdir(os.path.expanduser("~/.paperclip/seo-geo/_audit-history"))
             if len(f)==15 and f.endswith(".json"))[-1])))
# künstliche Vorwoche: eine Site mit weniger Findings, damit "Netto-Anstieg" + neu greift
prev = {k: {**v, "findings": (v.get("findings", [])[:-1] if v.get("findings") else []),
            "total": max((v.get("total",0)-1),0)} for k, v in cur.items() if isinstance(v, dict) and "total" in v}
json.dump(prev, open(os.path.expanduser("~/.paperclip/seo-geo/_audit-history/2000-01-01.json"), "w"), ensure_ascii=False)
print("Vorwochen-Snapshot 2000-01-01.json geschrieben")
PY
set -a; source ~/.whitestag.env 2>/dev/null; set +a
./venv/bin/python audit_summary.py --sites sites.json | sed -n '/Veränderungen seit Vorwoche/,/Google Search Console/p'
echo "--- Alarm-Flag ---"; cat ~/.paperclip/seo-geo/_audit-history/$(date +%F)-alert.txt; echo
rm -f ~/.paperclip/seo-geo/_audit-history/2000-01-01.json
```
Expected: Diff-Sektion zeigt `+ neu` / Netto-Anstieg für mindestens eine Site; Alarm-Flag `ALERT`.

- [ ] **Step 3: Fail-soft-Rauchtest (kein Alt-Snapshot)**

Run: `cd ~/.paperclip/scripts/seo-geo && ./venv/bin/python -m pytest -q && ./venv/bin/python audit_summary.py --sites sites.json | grep -A1 "Veränderungen seit Vorwoche" | head -3`
Expected: Suite grün; ohne künstlichen Snapshot zeigt die Sektion echten Diff gegen den letzten realen Snapshot (oder „keine Vergleichsbasis", falls nur heute existiert).

- [ ] **Step 4: Ganze Routine (kickstart)**

Run: `launchctl kickstart -k gui/$(id -u)/ing.whitestag.seo-geo-audit && sleep 90 && tail -30 /tmp/seo-geo-audit.log`
Expected: Lauf endet mit „Mail versendet (…)"; bei Verschlechterung trägt der Betreff das `⚠️`.

---

## Self-Review

**Spec-Coverage:**
- Snapshot speichert Findings → Task 1 ✓
- Finding-Diff (neu/behoben) über (url,field) → Task 2 (`diff_findings`) ✓
- Regression = neu + in älterem Snapshot → Task 2 (`find_regressions`), Task 3 (ältere Snapshots laden) ✓
- 4 Alarm-Trigger → Task 2 (`site_alerts`) ✓
- Mail-Sektion „Veränderungen" → Task 2 (`render_markdown`), Task 3 (Einhängen) ✓
- Betreff-⚠️ bei Alarm → Task 3 (Flag-Datei), Task 4 (Betreff) ✓
- `-gsc.json` nicht als Snapshot lesen → Task 1 (`_dated_snapshots`) ✓ (behebt zugleich den 5a-Nebenbug in `_prev_snapshot`)
- Fail-soft (Erstlauf/Alt-Format/defekt/Exception) → Task 3 (`diff_section` try/except + Erstlauf-Zweig) ✓
- Tests wie `test_*.py` → jede Kern-Task ✓

**Platzhalter:** keine „TBD/TODO"; jeder Code-Step zeigt vollständigen Code.

**Typ-Konsistenz:** `diff_findings` liefert `{"new","resolved"}` — in `site_alerts`/`diff_section` identisch gelesen. `per_site`-Dicts (`name,new,resolved,regressions,alerts`) durchgängig in `render_markdown`, `any_alert`, `diff_section`, Tests. `_dated_snapshots` liefert `list[(datestr, data)]` — in `_prev_snapshot` und `diff_section` gleich entpackt. `gsc_blocks`-Element-Keys `name`/`ampel` stimmen mit 5a (`build_site_block`-Output) überein.

**Offen (nicht blockierend):** „älterer Snapshot" = alle vorhandenen vor der Vorwoche (bei Wochen-Kadenz überschaubar); kein Fenster-Cap — bei Bedarf später begrenzen.
