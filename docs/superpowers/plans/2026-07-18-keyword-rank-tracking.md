# Keyword-Rank-Tracking (5d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wöchentliches Keyword-Rank-Tracking je Site (Ø-Position + Wochendelta) aus der bereits angebundenen Google Search Console — kostenlos, kein SERP-Scraping.

**Architecture:** `gsc.py` bekommt `fetch_query_metrics` (gezielte Query-Abfrage); neues reines Modul `rank_tracking.py` (Delta/Merge/Render); `audit_summary.py` hängt eine fail-soft `rank_section` an. Wiederverwendung des 5a-GSC-Clients.

**Tech Stack:** Python 3.11 (venv), `requests`/`requests_mock`, `pytest`. Keine neuen pip-Abhängigkeiten.

## Global Constraints

- **Python 3.11+** (venv `tools/seo-geo/venv`). Tests `./venv/bin/python -m pytest`.
- **Deploy:** `rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/`.
- **Fail-soft:** 5d darf Onpage+Diff+GSC+GEO+Mail nie kippen; kein neuer Alarm-Trigger (`<date>-alert.txt` unberührt).
- **GSC-Wiederverwendung:** `gsc.API_BASE`, `gsc.build_authorized_session`, `gsc.GSCClient`, `gsc.report_windows` aus 5a; Zeitfenster letzte 7 vs. vorherige 7 (Lag 3).
- **Position-Semantik:** kleinere Zahl = besser. `pos_delta = prev - cur` → **positiv = verbessert**.
- **Nur Impressionen:** GSC liefert nur Keywords mit Impressionen; Kern-Keyword ohne Row → `missing`.
- Commit-Messages enden mit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Modify `tools/seo-geo/gsc.py`** (+ `test_gsc.py`) — `fetch_query_metrics`.
- **Create `tools/seo-geo/rank_tracking.py`** (+ `test_rank_tracking.py`) — reine Logik.
- **Create `tools/seo-geo/geo_keywords.example.json`** — Beispiel-Config.
- **Modify `tools/seo-geo/audit_summary.py`** (+ `test_audit_summary.py`) — `rank_section` + main + `<date>-ranks.json`.

**Reihenfolge:** 1 → 2 → 3 → 4.

---

### Task 1: `gsc.py` — `fetch_query_metrics`

**Files:**
- Modify: `tools/seo-geo/gsc.py`, `tools/seo-geo/test_gsc.py`

**Interfaces:**
- Produces: `GSCClient.fetch_query_metrics(property_url, queries, start, end) -> list[dict]` — POST searchanalytics mit `dimensions:["query"]` + `dimensionFilterGroups` (groupType "or", je Query ein `equals`-Filter); Rückgabe je Zeile `{"key","clicks","impressions","ctr","position"}`. Leere `queries` → `[]` ohne HTTP-Call.

- [ ] **Step 1: Failing test schreiben** — `test_gsc.py` ergänzen:

```python
def test_fetch_query_metrics_baut_filter_und_parst():
    prop = "https://www.whitestag.film/"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query",
               json={"rows": [{"keys": ["360 grad film"], "clicks": 2, "impressions": 40,
                               "ctr": 0.05, "position": 8.3}]})
        rows = _client().fetch_query_metrics(prop, ["360 grad film", "vr cottbus"],
                                             "2026-07-09", "2026-07-15")
        assert rows[0] == {"key": "360 grad film", "clicks": 2, "impressions": 40,
                           "ctr": 0.05, "position": 8.3}
        body = m.last_request.json()
        assert body["dimensions"] == ["query"]
        fg = body["dimensionFilterGroups"][0]
        assert fg["groupType"] == "or"
        assert {f["expression"] for f in fg["filters"]} == {"360 grad film", "vr cottbus"}
        assert all(f["dimension"] == "query" and f["operator"] == "equals" for f in fg["filters"])

def test_fetch_query_metrics_leere_liste_kein_call():
    with requests_mock.Mocker() as m:
        assert _client().fetch_query_metrics("https://x/", [], "a", "b") == []
        assert m.call_count == 0
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_gsc.py -k fetch_query_metrics -v`
Expected: FAIL (`AttributeError: … has no attribute 'fetch_query_metrics'`).

- [ ] **Step 3: Implementieren** — in `gsc.py`, Methode zur `GSCClient` ergänzen (nutzt vorhandenes `self._query`):

```python
    def fetch_query_metrics(self, property_url, queries, start, end):
        if not queries:
            return []
        body = {"startDate": start, "endDate": end, "dimensions": ["query"],
                "dimensionFilterGroups": [{
                    "groupType": "or",
                    "filters": [{"dimension": "query", "operator": "equals", "expression": q}
                                for q in queries]}],
                "rowLimit": max(len(queries), 25)}
        data = self._query(property_url, body)
        out = []
        for row in data.get("rows") or []:
            out.append({"key": row["keys"][0],
                        "clicks": int(row.get("clicks", 0)),
                        "impressions": int(row.get("impressions", 0)),
                        "ctr": float(row.get("ctr", 0.0)),
                        "position": float(row.get("position", 0.0))})
        return out
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_gsc.py -v`
Expected: PASS (bestehende + 2 neue).

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/gsc.py tools/seo-geo/test_gsc.py
git commit -m "feat(seo-geo): GSC fetch_query_metrics (gezielte Keyword-Abfrage)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `rank_tracking.py` — Delta/Merge/Render (rein)

**Files:**
- Create: `tools/seo-geo/rank_tracking.py`, `tools/seo-geo/test_rank_tracking.py`, `tools/seo-geo/geo_keywords.example.json`

**Interfaces:**
- Produces:
  - `pos_delta(prev_pos, cur_pos) -> float | None` (`prev - cur`, gerundet 1; None wenn `prev_pos` None).
  - `build_site_ranks(cur_rows, prev_rows, core_keys) -> list[dict]` — je Keyword
    `{key, core, position, impressions, delta, missing?}`. Union aus cur_rows-Keys und core_keys;
    Kern-Keyword ohne cur_row → `{key, core:True, missing:True}`. `core` = key in core_keys.
  - `render_markdown(per_site) -> str`.

- [ ] **Step 1: Beispiel-Config** — `geo_keywords.example.json`:

```json
{
  "auto_top": 10,
  "keywords": {
    "whitestag.film": ["360 grad film", "vr filmproduktion cottbus", "virtuelles cottbus"],
    "whitestag.ai": ["ki beratung lausitz", "ki agenten unternehmen"],
    "whitestag.de": [],
    "virtuelle-lausitz.de": []
  }
}
```

- [ ] **Step 2: Failing tests schreiben** — `test_rank_tracking.py`:

```python
from rank_tracking import pos_delta, build_site_ranks, render_markdown

def _row(key, pos, imp=10):
    return {"key": key, "position": pos, "impressions": imp, "clicks": 0, "ctr": 0.0}

def test_pos_delta_positiv_ist_verbesserung():
    assert pos_delta(8.0, 5.0) == 3.0     # von Pos 8 auf 5 = +3 (besser)
    assert pos_delta(5.0, 8.0) == -3.0
    assert pos_delta(None, 5.0) is None

def test_build_site_ranks_union_core_und_auto():
    cur = [_row("a", 5.0), _row("b", 12.0)]
    prev = [_row("a", 8.0)]
    ranks = build_site_ranks(cur, prev, core_keys={"a", "z"})
    by = {r["key"]: r for r in ranks}
    assert by["a"]["core"] is True and by["a"]["delta"] == 3.0 and by["a"]["position"] == 5.0
    assert by["b"]["core"] is False and by["b"]["delta"] is None      # keine Vorwoche für b
    assert by["z"]["core"] is True and by["z"].get("missing") is True # core ohne Impressionen

def test_render_markdown_zeigt_pfeile_und_keys():
    md = render_markdown([{"name": "whitestag.film", "ranks": [
        {"key": "a", "core": True, "position": 5.0, "impressions": 40, "delta": 3.0},
        {"key": "z", "core": True, "missing": True}]}])
    assert "whitestag.film" in md and "a" in md and "z" in md
    assert "↑" in md   # Verbesserung
```

- [ ] **Step 3: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_rank_tracking.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'rank_tracking'`).

- [ ] **Step 4: `rank_tracking.py` implementieren**

```python
"""Keyword-Rank-Tracking aus GSC-Positionsdaten. Rein: kein HTTP, kein Mail."""


def pos_delta(prev_pos, cur_pos):
    if prev_pos is None:
        return None
    return round(prev_pos - cur_pos, 1)


def build_site_ranks(cur_rows, prev_rows, core_keys):
    cur = {r["key"]: r for r in cur_rows}
    prev = {r["key"]: r for r in prev_rows}
    core_keys = set(core_keys or [])
    ranks = []
    for key in list(cur.keys()) + [k for k in core_keys if k not in cur]:
        if key not in cur:
            ranks.append({"key": key, "core": True, "missing": True})
            continue
        r = cur[key]
        prev_pos = prev[key]["position"] if key in prev else None
        ranks.append({"key": key, "core": key in core_keys,
                      "position": r["position"], "impressions": r["impressions"],
                      "delta": pos_delta(prev_pos, r["position"])})
    return ranks


def _arrow(delta):
    if delta is None:
        return "–"
    if delta > 0:
        return f"↑ +{delta}"
    if delta < 0:
        return f"↓ {delta}"
    return "→ ±0"


def render_markdown(per_site):
    lines = ["", "## Keyword-Rankings (GSC, Ø-Position)", ""]
    for s in per_site:
        lines.append(f"**{s['name']}**")
        ranks = s.get("ranks", [])
        # Kern-Keywords zuerst, dann Auto nach Impressionen
        ranks = sorted(ranks, key=lambda r: (not r.get("core"), -(r.get("impressions") or 0)))
        if not ranks:
            lines.append("  - keine Rank-Daten")
            continue
        for r in ranks:
            tag = " (Kern)" if r.get("core") else ""
            if r.get("missing"):
                lines.append(f"  - {r['key']}{tag}: nicht in GSC (keine Impressionen)")
            else:
                lines.append(f"  - {r['key']}{tag}: Pos {round(r['position'],1)} "
                             f"{_arrow(r.get('delta'))} · {r['impressions']} Impr.")
    lines.append("")
    return "\n".join(lines)
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_rank_tracking.py -v`
Expected: PASS (3 Tests).

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/rank_tracking.py tools/seo-geo/test_rank_tracking.py tools/seo-geo/geo_keywords.example.json
git commit -m "feat(seo-geo): Rank-Tracking-Logik (Delta/Merge/Render, Kern+Auto)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `rank_section` in `audit_summary.py` + main-Wiring

**Files:**
- Modify: `tools/seo-geo/audit_summary.py`, `tools/seo-geo/test_audit_summary.py`

**Interfaces:**
- Consumes: `gsc.build_authorized_session/GSCClient/report_windows`, `gsc_report.resolve_property`, `rank_tracking.*`, `config.load_sites`.
- Produces: `rank_section(sites_path, environ, today) -> tuple[str, dict]` (markdown, ranks_data); main hängt Sektion an + schreibt `<date>-ranks.json`.

- [ ] **Step 1: Failing test schreiben** — `test_audit_summary.py`:

```python
import datetime
from audit_summary import rank_section

def test_rank_section_ohne_key_ist_failsoft(tmp_path):
    sites = tmp_path / "sites.json"
    sites.write_text('{"report_root":"%s","sites":[]}' % tmp_path)
    md, data = rank_section(str(sites), {}, datetime.date(2026, 7, 18))
    assert "Keyword-Rankings" in md
    assert "nicht konfiguriert" in md
    assert isinstance(data, dict)
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -k rank_section -v`
Expected: FAIL (`ImportError: cannot import name 'rank_section'`).

- [ ] **Step 3: `rank_section` implementieren + main-Wiring** — in `audit_summary.py`:

```python
def rank_section(sites_path, environ, today):
    """Fail-soft Keyword-Rank-Tracking via GSC (Kern-Keywords + Auto-Top-Queries)."""
    import json as _json
    lines = ["", "## Keyword-Rankings (GSC, Ø-Position)", ""]
    ranks_data = {}
    key_file = environ.get("GSC_SA_KEY_FILE")
    if not key_file or not os.path.exists(os.path.expanduser(key_file)):
        return ("\n## Keyword-Rankings (GSC, Ø-Position)\n\n"
                "GSC nicht konfiguriert — kein Rank-Tracking.\n", {})
    try:
        import gsc, gsc_report, rank_tracking
        from config import load_sites
        kw_path = os.path.join(os.path.dirname(os.path.abspath(sites_path)), "geo_keywords.json")
        kw_cfg = _json.loads(open(kw_path).read()) if os.path.exists(kw_path) else {"auto_top": 10, "keywords": {}}
        auto_top = kw_cfg.get("auto_top", 10)
        core_map = kw_cfg.get("keywords", {})
        session = gsc.build_authorized_session(os.path.expanduser(key_file))
        client = gsc.GSCClient(session)
        (ls, le), (ps, pe) = gsc.report_windows(today)
        per_site = []
        for site in load_sites(sites_path):
            try:
                prop = gsc_report.resolve_property(site, client)
                if not prop:
                    per_site.append({"name": site.name, "ranks": []})
                    continue
                core = core_map.get(site.name, [])
                cur = client.fetch_top(prop, "query", ls, le, auto_top)
                if core:
                    cur = cur + client.fetch_query_metrics(prop, core, ls, le)
                prev = client.fetch_top(prop, "query", ps, pe, auto_top)
                if core:
                    prev = prev + client.fetch_query_metrics(prop, core, ps, pe)
                # Dedupe cur/prev nach key (fetch_top + fetch_query_metrics können überlappen)
                cur = list({r["key"]: r for r in cur}.values())
                prev = list({r["key"]: r for r in prev}.values())
                ranks = rank_tracking.build_site_ranks(cur, prev, set(core))
                per_site.append({"name": site.name, "ranks": ranks})
                ranks_data[site.name] = ranks
            except Exception as e:  # noqa: BLE001
                per_site.append({"name": site.name, "ranks": []})
                lines_err = f"  - {site.name}: keine Rank-Daten ({e})"
                per_site[-1]["_err"] = lines_err
        md = rank_tracking.render_markdown(per_site)
        # etwaige Fehlerzeilen anhängen
        errs = [s["_err"] for s in per_site if s.get("_err")]
        if errs:
            md = md + "\n".join(errs) + "\n"
        return md, ranks_data
    except Exception as e:  # noqa: BLE001
        return (f"\n## Keyword-Rankings (GSC, Ø-Position)\n\nRank-Tracking fehlgeschlagen ({e}).\n", {})
```

In `main()`, NACH dem GEO-Block (`body = body + geo_md`) einfügen:

```python
    rank_md, rank_data = rank_section(args.sites, os.environ, today_date)
    body = body + rank_md
    with open(os.path.join(hist_dir, f"{today}-ranks.json"), "w") as fh:
        json.dump(rank_data, fh, ensure_ascii=False, indent=2)
```

(`today_date` = `datetime.date`; `today` = String — beide existieren.)

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -v`
Expected: PASS.

- [ ] **Step 5: Gesamt-Suite**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest -q`
Expected: PASS (alle).

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/audit_summary.py tools/seo-geo/test_audit_summary.py
git commit -m "feat(seo-geo): Keyword-Rankings-Sektion (GSC) in die Wochen-Mail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Deploy + End-to-End-Verifikation

**Files:** keine (Deploy, Config, Verifikation).

- [ ] **Step 1: geo_keywords.json im Deploy anlegen**

```bash
cp tools/seo-geo/geo_keywords.example.json ~/.paperclip/scripts/seo-geo/geo_keywords.json
```

- [ ] **Step 2: Deploy**

```bash
cd "$(git rev-parse --show-toplevel)"
rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/
```

- [ ] **Step 3: Live-Test (echte GSC-Daten)**

```bash
cd ~/.paperclip/scripts/seo-geo
set -a; source ~/.whitestag.env 2>/dev/null; set +a
./venv/bin/python - <<'PY'
import datetime, os, audit_summary
md, data = audit_summary.rank_section("sites.json", os.environ, datetime.date.today())
print(md)
print("=== sites mit ranks:", list(data))
PY
```
Expected: „Keyword-Rankings"-Sektion je Site mit Ø-Positionen der Top-Queries + (falls Kern-Keywords Impressionen haben) deren Position; Kern-Keywords ohne Impressionen als „nicht in GSC".

- [ ] **Step 4: Suite + ganze Routine**

```bash
cd ~/.paperclip/scripts/seo-geo && ./venv/bin/python -m pytest -q
launchctl kickstart -k gui/$(id -u)/ing.whitestag.seo-geo-audit && sleep 300 && tail -50 /tmp/seo-geo-audit.log
```
Expected: Suite grün; Mail enthält die „Keyword-Rankings"-Sektion. (Der ganze Lauf inkl. GEO-Prompts dauert einige Minuten.)

---

## Self-Review

**Spec-Coverage:**
- `fetch_query_metrics` (gezielte Keyword-Abfrage, Filter) → Task 1 ✓
- pos_delta/merge/build/render (Kern ∪ Auto, missing) → Task 2 ✓
- Config `geo_keywords.json` (Kern-Liste + auto_top) → Task 2 (example), Task 3 (laden), Task 4 (deploy) ✓
- `rank_section` + `<date>-ranks.json` + Mail-Sektion → Task 3 ✓
- Fail-soft (kein Key/keine Keywords/Property-Fehler/Exception) → Task 3 ✓
- Kein neuer Alarm (nur (md, data), `<date>-alert.txt` unberührt) → Task 3 ✓
- Position-Semantik (kleiner=besser, delta=prev-cur) → Task 2 ✓
- Keine Backlinks / kein bezahlter Dienst → nichts dergleichen im Plan ✓
- Tests wie `test_*.py` → Tasks 1,2,3 ✓

**Platzhalter:** keine; jeder Code-Step zeigt vollständigen Code.

**Typ-Konsistenz:** `fetch_query_metrics`/`fetch_top` liefern gleiche Row-Form (`key/clicks/impressions/ctr/position`) — in `build_site_ranks` einheitlich gelesen. `build_site_ranks` liefert Dicts mit `key/core/position/impressions/delta/missing` — in `render_markdown` und Test gleich. `resolve_property`/`report_windows`/`GSCClient` == 5a-Signaturen. `rank_section` gibt `(str, dict)` — main schreibt `dict` als `<date>-ranks.json`.

**Offen (nicht blockierend):** Rank-Verschlechterung als 5b-Alarm-Kriterium = v2; `auto_top` justierbar.
