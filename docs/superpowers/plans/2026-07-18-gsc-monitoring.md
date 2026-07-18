# GSC-Monitoring (5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die wöchentliche SEO/GEO-Audit-Mail um einen Google-Search-Console-Block je Site erweitern (Klicks/Impressionen/CTR/Position + Wochendelta + Top-Listen + Bewegungen + Klick-Einbruch-Ampel).

**Architecture:** Zwei neue Module im bestehenden `tools/seo-geo/`-Dienst: `gsc.py` (GSC-REST-Client mit injizierter Session — Produktion `google.auth`-`AuthorizedSession`, Test `requests_mock`) und `gsc_report.py` (reine Report-/Ampel-Logik). `audit_summary.py` ruft sie fail-soft auf und hängt die GSC-Sektion an die Mail an.

**Tech Stack:** Python 3.11 (venv), `requests`, `google-auth` (nur für Service-Account-Token), `pytest` + `requests_mock`.

## Global Constraints

- **Python 3.11+** (venv unter `tools/seo-geo/venv`; System-python3 = 3.9 bricht `str | None`). Immer `./venv/bin/python`.
- **Deploy:** `rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/`.
- **Kein Secret in CloudStorage:** SA-JSON-Key liegt nur unter `~/.paperclip/scripts/seo-geo/`; Pfad kommt aus Env `GSC_SA_KEY_FILE` (in `~/.whitestag.env`).
- **Fail-soft:** Der GSC-Teil darf die bestehende Onpage-Audit-Mail nie kippen. Fehlt der Key oder scheitert ein Abruf, läuft alles Übrige normal weiter.
- **GSC-Scope:** `https://www.googleapis.com/auth/webmasters.readonly` (nur lesen).
- **API-Base:** `https://www.googleapis.com/webmasters/v3`.
- **Ampel-Schwellen (Klick-Delta Wo-zu-Wo):** 🟢 ≥ −10 % · 🟡 −25 % … < −10 % · 🔴 < −25 %.
- **Zeitfenster:** Lag 3 Tage → `end = today − 3`; letzte Woche `[end−6, end]`, Vorwoche `[end−13, end−7]` (ISO-Datumsstrings).
- **Deutsch** in allen mailseitigen Texten; Commit-Messages mit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create `tools/seo-geo/gsc.py`** — GSC-REST-Client + Session-Factory + Zeitfenster-Helfer.
- **Create `tools/seo-geo/gsc_report.py`** — reine Report-Logik (Delta, Ampel, Movers, Block-Bau, Markdown).
- **Create `tools/seo-geo/test_gsc.py`** — Client-Tests (requests_mock).
- **Create `tools/seo-geo/test_gsc_report.py`** — Report-Logik-Tests.
- **Modify `tools/seo-geo/config.py`** — `Site.gsc_property: str | None`.
- **Modify `tools/seo-geo/test_config.py`** — `gsc_property` optional/geladen.
- **Modify `tools/seo-geo/audit_summary.py`** — GSC-Sektion, Betreff-Signal, `<datum>-gsc.json`.
- **Modify `tools/seo-geo/requirements.txt`** — `google-auth`.
- **Modify `tools/seo-geo/sites.json`** — `gsc_property` je Site (Deploy-Zeit).
- **Modify `tools/seo-geo/wp-mu-plugin/…php`** — `google-site-verification`-Meta-Tag (v0.2.0) für ai/de/vl.

**Reihenfolge:** Task 1 → 2 → 3 → 4 (Kernkette). Task 5 (mu-Plugin-Verifizierung) und Task 6 (sites.json + Deploy) sind unabhängig davon und schließen an.

---

### Task 1: `config.py` — optionales Feld `gsc_property`

**Files:**
- Modify: `tools/seo-geo/config.py`
- Test: `tools/seo-geo/test_config.py`

**Interfaces:**
- Produces: `Site.gsc_property: str | None` (Default `None`); `load_sites(path)` liest den optionalen Schlüssel `gsc_property` je Site aus `sites.json`.

- [ ] **Step 1: Failing test schreiben** — in `test_config.py` ergänzen:

```python
import json, tempfile, os
from config import load_sites

def _write(sites):
    fd, p = tempfile.mkstemp(suffix=".json")
    os.write(fd, json.dumps({"report_root": "~/x", "sites": sites}).encode())
    os.close(fd)
    return p

def test_gsc_property_geladen_wenn_vorhanden():
    p = _write([{"name": "a", "url": "https://a.de", "wp_rest_base": "https://a.de/wp-json",
                 "credential_ref": "A", "crawl_limit": 10, "seo_plugin": "yoast",
                 "gsc_property": "sc-domain:a.de"}])
    assert load_sites(p)[0].gsc_property == "sc-domain:a.de"

def test_gsc_property_default_none_wenn_fehlt():
    p = _write([{"name": "a", "url": "https://a.de", "wp_rest_base": "https://a.de/wp-json",
                 "credential_ref": "A", "crawl_limit": 10, "seo_plugin": "yoast"}])
    assert load_sites(p)[0].gsc_property is None
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_config.py -k gsc_property -v`
Expected: FAIL (`TypeError: __init__() got ... 'gsc_property'` bzw. AttributeError).

- [ ] **Step 3: Minimal implementieren** — `config.py`:

```python
import json, os
from dataclasses import dataclass

@dataclass
class Site:
    name: str
    url: str
    wp_rest_base: str
    credential_ref: str
    crawl_limit: int
    seo_plugin: str
    gsc_property: str | None = None

def load_sites(path: str) -> list[Site]:
    data = json.loads(open(os.path.expanduser(path)).read())
    keys = ("name", "url", "wp_rest_base", "credential_ref", "crawl_limit", "seo_plugin")
    out = []
    for s in data["sites"]:
        kw = {k: s[k] for k in keys}
        if s.get("gsc_property"):
            kw["gsc_property"] = s["gsc_property"]
        out.append(Site(**kw))
    return out
```

(`resolve_credential` bleibt unverändert.)

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_config.py -v`
Expected: PASS (alle, inkl. der bestehenden config-Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/config.py tools/seo-geo/test_config.py
git commit -m "feat(seo-geo): optionales gsc_property-Feld in Site-Config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `gsc.py` — GSC-REST-Client, Session-Factory, Zeitfenster

**Files:**
- Create: `tools/seo-geo/gsc.py`
- Create: `tools/seo-geo/test_gsc.py`
- Modify: `tools/seo-geo/requirements.txt`

**Interfaces:**
- Consumes: nichts aus früheren Tasks.
- Produces:
  - `GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"`
  - `API_BASE = "https://www.googleapis.com/webmasters/v3"`
  - `class GSCClient(session)` mit
    `list_properties() -> list[str]`,
    `fetch_totals(property_url, start, end) -> dict` (Keys `clicks:int, impressions:int, ctr:float, position:float`, Nullen wenn keine Daten),
    `fetch_top(property_url, dimension, start, end, limit) -> list[dict]` (je Zeile `{"key":str,"clicks":int,"impressions":int,"ctr":float,"position":float}`).
  - `build_authorized_session(key_file, scopes=(GSC_SCOPE,))` → `google.auth`-`AuthorizedSession` (nur Produktion, nicht unit-getestet).
  - `report_windows(today) -> tuple[tuple[str,str], tuple[str,str]]` → `((last_start,last_end),(prev_start,prev_end))`, Lag 3, Länge 7, ISO-Strings.

- [ ] **Step 1: requirements ergänzen**

`tools/seo-geo/requirements.txt` — Zeile anhängen:

```
google-auth==2.34.0
```

- [ ] **Step 2: Abhängigkeit installieren**

Run: `cd tools/seo-geo && ./venv/bin/pip install google-auth==2.34.0`
Expected: „Successfully installed google-auth-2.34.0 …".

- [ ] **Step 3: Failing tests schreiben** — `test_gsc.py`:

```python
import datetime, requests, requests_mock
from gsc import GSCClient, report_windows, API_BASE

def _client():
    return GSCClient(requests.Session())

def test_report_windows_lag_und_laenge():
    (ls, le), (ps, pe) = report_windows(datetime.date(2026, 7, 18))
    assert le == "2026-07-15"           # today - 3
    assert ls == "2026-07-09"           # end - 6
    assert pe == "2026-07-08"           # end - 7
    assert ps == "2026-07-02"           # end - 13

def test_list_properties():
    with requests_mock.Mocker() as m:
        m.get(f"{API_BASE}/sites", json={"siteEntry": [
            {"siteUrl": "https://www.whitestag.film/", "permissionLevel": "siteOwner"},
            {"siteUrl": "sc-domain:whitestag.de", "permissionLevel": "siteRestrictedUser"}]})
        assert _client().list_properties() == [
            "https://www.whitestag.film/", "sc-domain:whitestag.de"]

def test_fetch_totals_aggregiert_eine_zeile():
    prop = "https://www.whitestag.film/"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query",
               json={"rows": [{"clicks": 120, "impressions": 3400, "ctr": 0.035, "position": 12.4}]})
        t = _client().fetch_totals(prop, "2026-07-09", "2026-07-15")
        assert t == {"clicks": 120, "impressions": 3400, "ctr": 0.035, "position": 12.4}

def test_fetch_totals_ohne_daten_gibt_nullen():
    prop = "sc-domain:whitestag.de"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query", json={})
        t = _client().fetch_totals(prop, "2026-07-09", "2026-07-15")
        assert t == {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0}

def test_fetch_top_liefert_keys():
    prop = "https://www.whitestag.film/"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query",
               json={"rows": [{"keys": ["vr film"], "clicks": 50, "impressions": 900, "ctr": 0.055, "position": 4.1}]})
        rows = _client().fetch_top(prop, "query", "2026-07-09", "2026-07-15", 5)
        assert rows[0] == {"key": "vr film", "clicks": 50, "impressions": 900, "ctr": 0.055, "position": 4.1}
        assert m.last_request.json()["dimensions"] == ["query"]
        assert m.last_request.json()["rowLimit"] == 5
```

- [ ] **Step 4: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_gsc.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'gsc'`).

- [ ] **Step 5: `gsc.py` implementieren**

```python
"""GSC-REST-Client. Session wird injiziert (Produktion: google.auth AuthorizedSession;
Test: gemockte requests.Session)."""
import datetime
import requests

GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
API_BASE = "https://www.googleapis.com/webmasters/v3"


def report_windows(today):
    end = today - datetime.timedelta(days=3)
    last = (end - datetime.timedelta(days=6), end)
    prev = (end - datetime.timedelta(days=13), end - datetime.timedelta(days=7))
    fmt = lambda d: d.isoformat()
    return (fmt(last[0]), fmt(last[1])), (fmt(prev[0]), fmt(prev[1]))


class GSCClient:
    def __init__(self, session):
        self.http = session

    def list_properties(self):
        r = self.http.get(f"{API_BASE}/sites", timeout=30)
        r.raise_for_status()
        return [e["siteUrl"] for e in r.json().get("siteEntry", [])]

    def _query(self, property_url, body):
        prop = requests.utils.quote(property_url, safe="")
        r = self.http.post(f"{API_BASE}/sites/{prop}/searchAnalytics/query",
                           json=body, timeout=30)
        r.raise_for_status()
        return r.json()

    def fetch_totals(self, property_url, start, end):
        data = self._query(property_url, {"startDate": start, "endDate": end})
        rows = data.get("rows") or []
        if not rows:
            return {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0}
        row = rows[0]
        return {"clicks": int(row.get("clicks", 0)),
                "impressions": int(row.get("impressions", 0)),
                "ctr": float(row.get("ctr", 0.0)),
                "position": float(row.get("position", 0.0))}

    def fetch_top(self, property_url, dimension, start, end, limit):
        data = self._query(property_url, {"startDate": start, "endDate": end,
                                          "dimensions": [dimension], "rowLimit": limit})
        out = []
        for row in data.get("rows") or []:
            out.append({"key": row["keys"][0],
                        "clicks": int(row.get("clicks", 0)),
                        "impressions": int(row.get("impressions", 0)),
                        "ctr": float(row.get("ctr", 0.0)),
                        "position": float(row.get("position", 0.0))})
        return out


def build_authorized_session(key_file, scopes=(GSC_SCOPE,)):
    """Produktions-Session mit Service-Account-Auth. Nicht unit-getestet (google-Plumbing)."""
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    creds = service_account.Credentials.from_service_account_file(key_file, scopes=list(scopes))
    return AuthorizedSession(creds)
```

- [ ] **Step 6: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_gsc.py -v`
Expected: PASS (5 Tests).

- [ ] **Step 7: Commit**

```bash
git add tools/seo-geo/gsc.py tools/seo-geo/test_gsc.py tools/seo-geo/requirements.txt
git commit -m "feat(seo-geo): GSC-REST-Client (Totals/Top/Properties) + Zeitfenster

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `gsc_report.py` — Delta, Ampel, Movers, Block-Bau, Markdown

**Files:**
- Create: `tools/seo-geo/gsc_report.py`
- Create: `tools/seo-geo/test_gsc_report.py`

**Interfaces:**
- Consumes: `gsc.GSCClient`, `gsc.report_windows`, `config.Site`.
- Produces:
  - `delta_pct(cur, prev) -> float | None` (None wenn `prev == 0`).
  - `ampel(click_delta_pct) -> str` (🟢/🟡/🔴; None → 🟢).
  - `movers(prev_rows, cur_rows, n=3) -> tuple[list[dict], list[dict]]` (Gewinner, Verlierer nach Klick-Differenz je `key`; jedes `{"key","delta"}`).
  - `build_site_block(site, client, windows) -> dict` mit Keys `name, property, ok, error, cur, prev, deltas, top_queries, top_pages, winners, losers, ampel`.
  - `resolve_property(site, client) -> str | None` (nutzt `site.gsc_property` sonst Auto-Match gegen `client.list_properties()` per Host).
  - `overall_ampel(blocks) -> str` (schlechteste Ampel; 🔴 > 🟡 > 🟢).
  - `render_markdown(blocks) -> str`.

- [ ] **Step 1: Failing tests schreiben** — `test_gsc_report.py`:

```python
from config import Site
from gsc_report import (delta_pct, ampel, movers, resolve_property,
                        build_site_block, overall_ampel, render_markdown)

def _site(name="whitestag.film", url="https://www.whitestag.film", prop=None):
    return Site(name=name, url=url, wp_rest_base=url + "/wp-json",
                credential_ref="X", crawl_limit=10, seo_plugin="yoast", gsc_property=prop)

def test_delta_pct_normal():
    assert delta_pct(120, 100) == 20.0
    assert delta_pct(80, 100) == -20.0

def test_delta_pct_prev_null_ist_none():
    assert delta_pct(50, 0) is None

def test_ampel_schwellen():
    assert ampel(None) == "🟢"
    assert ampel(-5) == "🟢"
    assert ampel(-10) == "🟢"
    assert ampel(-10.1) == "🟡"
    assert ampel(-25) == "🟡"
    assert ampel(-25.1) == "🔴"

def test_movers_gewinner_und_verlierer():
    prev = [{"key": "a", "clicks": 100}, {"key": "b", "clicks": 50}, {"key": "c", "clicks": 10}]
    cur = [{"key": "a", "clicks": 60}, {"key": "b", "clicks": 90}, {"key": "c", "clicks": 12}]
    win, lose = movers(prev, cur, n=1)
    assert win[0]["key"] == "b" and win[0]["delta"] == 40
    assert lose[0]["key"] == "a" and lose[0]["delta"] == -40

class _FakeClient:
    def __init__(self, props=None, totals=None, top=None):
        self._props = props or []
        self._totals = totals or {}
        self._top = top or {}
    def list_properties(self):
        return self._props
    def fetch_totals(self, prop, start, end):
        return self._totals.get((start, end), {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0})
    def fetch_top(self, prop, dim, start, end, limit):
        return self._top.get((dim, start), [])

def test_resolve_property_explizit():
    assert resolve_property(_site(prop="sc-domain:whitestag.film"), _FakeClient()) == "sc-domain:whitestag.film"

def test_resolve_property_automatch_per_host():
    c = _FakeClient(props=["sc-domain:whitestag.film", "https://other.de/"])
    assert resolve_property(_site(), c) == "sc-domain:whitestag.film"

def test_resolve_property_kein_treffer_none():
    assert resolve_property(_site(), _FakeClient(props=["https://other.de/"])) is None

def test_build_site_block_ohne_property():
    b = build_site_block(_site(), _FakeClient(props=[]), (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08")))
    assert b["ok"] is False and "nicht in GSC" in b["error"]

def test_build_site_block_mit_daten_und_ampel():
    w = (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08"))
    c = _FakeClient(props=["sc-domain:whitestag.film"],
                    totals={("2026-07-09", "2026-07-15"): {"clicks": 60, "impressions": 1000, "ctr": 0.06, "position": 5.0},
                            ("2026-07-02", "2026-07-08"): {"clicks": 100, "impressions": 1200, "ctr": 0.083, "position": 4.5}},
                    top={("query", "2026-07-09"): [{"key": "vr", "clicks": 30, "impressions": 400, "ctr": 0.075, "position": 3.0}]})
    b = build_site_block(_site(prop="sc-domain:whitestag.film"), c, w)
    assert b["ok"] is True
    assert b["deltas"]["clicks"] == -40.0        # (60-100)/100*100
    assert b["ampel"] == "🔴"                     # -40% < -25%
    assert b["top_queries"][0]["key"] == "vr"

def test_overall_ampel_nimmt_schlechteste():
    assert overall_ampel([{"ampel": "🟢"}, {"ampel": "🔴"}, {"ampel": "🟡"}]) == "🔴"

def test_render_markdown_enthaelt_sitename_und_ampel():
    md = render_markdown([{"name": "whitestag.film", "ok": True, "ampel": "🟢",
                           "cur": {"clicks": 60, "impressions": 1000, "ctr": 0.06, "position": 5.0},
                           "deltas": {"clicks": 20.0, "impressions": 5.0, "ctr": 1.0, "position": -0.3},
                           "top_queries": [{"key": "vr", "clicks": 30}], "top_pages": [],
                           "winners": [], "losers": []}])
    assert "whitestag.film" in md and "🟢" in md and "vr" in md
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_gsc_report.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'gsc_report'`).

- [ ] **Step 3: `gsc_report.py` implementieren**

```python
"""Reine Report-Logik für den GSC-Block der Wochen-Mail. Kein HTTP, kein Mailversand."""
from urllib.parse import urlparse

_RANK = {"🟢": 0, "🟡": 1, "🔴": 2}


def delta_pct(cur, prev):
    if prev == 0:
        return None
    return round((cur - prev) / prev * 100, 1)


def ampel(click_delta_pct):
    if click_delta_pct is None or click_delta_pct >= -10:
        return "🟢"
    if click_delta_pct >= -25:
        return "🟡"
    return "🔴"


def movers(prev_rows, cur_rows, n=3):
    prev = {r["key"]: r["clicks"] for r in prev_rows}
    cur = {r["key"]: r["clicks"] for r in cur_rows}
    diffs = [{"key": k, "delta": cur.get(k, 0) - prev.get(k, 0)}
             for k in set(prev) | set(cur)]
    diffs.sort(key=lambda d: d["delta"], reverse=True)
    winners = [d for d in diffs if d["delta"] > 0][:n]
    losers = [d for d in reversed(diffs) if d["delta"] < 0][:n]
    return winners, losers


def _host(value):
    host = value.split(":", 1)[1] if value.startswith("sc-domain:") else urlparse(value).netloc
    return host.removeprefix("www.")


def resolve_property(site, client):
    if site.gsc_property:
        return site.gsc_property
    target = _host(site.url)
    for prop in client.list_properties():
        if _host(prop) == target:
            return prop
    return None


def build_site_block(site, client, windows):
    (ls, le), (ps, pe) = windows
    block = {"name": site.name, "property": None, "ok": False, "error": None,
             "cur": {}, "prev": {}, "deltas": {}, "top_queries": [], "top_pages": [],
             "winners": [], "losers": [], "ampel": "🟢"}
    try:
        prop = resolve_property(site, client)
    except Exception as e:  # list_properties kann fehlschlagen
        block["error"] = f"GSC-Abruf fehlgeschlagen ({e})"
        return block
    if not prop:
        block["error"] = "nicht in GSC / nicht verifiziert"
        return block
    block["property"] = prop
    try:
        cur = client.fetch_totals(prop, ls, le)
        prev = client.fetch_totals(prop, ps, pe)
        tq = client.fetch_top(prop, "query", ls, le, 5)
        tp = client.fetch_top(prop, "page", ls, le, 5)
        pq = client.fetch_top(prop, "query", ps, pe, 25)
    except Exception as e:
        block["error"] = f"GSC-Abruf fehlgeschlagen ({e})"
        return block
    block["ok"] = True
    block["cur"], block["prev"] = cur, prev
    block["deltas"] = {k: delta_pct(cur[k], prev[k]) for k in ("clicks", "impressions", "ctr", "position")}
    block["top_queries"], block["top_pages"] = tq, tp
    block["winners"], block["losers"] = movers(pq, tq, n=3)
    block["ampel"] = ampel(block["deltas"]["clicks"])
    return block


def overall_ampel(blocks):
    worst = "🟢"
    for b in blocks:
        if _RANK.get(b.get("ampel", "🟢"), 0) > _RANK[worst]:
            worst = b["ampel"]
    return worst


def _fmt_delta(v):
    if v is None:
        return "n/a"
    return f"{'+' if v >= 0 else ''}{v}%"


def render_markdown(blocks):
    lines = ["", "## Google Search Console (letzte 7 vs. vorherige 7 Tage)", ""]
    for b in blocks:
        if not b.get("ok"):
            lines.append(f"**{b['name']}** — {b.get('error') or 'keine Daten'}")
            continue
        c, d = b["cur"], b["deltas"]
        lines.append(f"**{b['name']}** {b['ampel']} — "
                     f"Klicks {c['clicks']} ({_fmt_delta(d['clicks'])}) · "
                     f"Impressionen {c['impressions']} ({_fmt_delta(d['impressions'])}) · "
                     f"CTR {round(c['ctr']*100,1)}% · Ø-Pos {round(c['position'],1)}")
        if b["top_queries"]:
            lines.append("  - Top-Queries: " + ", ".join(f"{r['key']} ({r['clicks']})" for r in b["top_queries"]))
        if b["top_pages"]:
            lines.append("  - Top-Seiten: " + ", ".join(f"{r['key']} ({r['clicks']})" for r in b["top_pages"]))
        if b["winners"]:
            lines.append("  - Gewinner: " + ", ".join(f"{w['key']} (+{w['delta']})" for w in b["winners"]))
        if b["losers"]:
            lines.append("  - Verlierer: " + ", ".join(f"{l['key']} ({l['delta']})" for l in b["losers"]))
    lines.append("")
    return "\n".join(lines)
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_gsc_report.py -v`
Expected: PASS (11 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/gsc_report.py tools/seo-geo/test_gsc_report.py
git commit -m "feat(seo-geo): GSC-Report-Logik (Delta/Ampel/Movers/Markdown)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `audit_summary.py` — GSC-Sektion integrieren (fail-soft)

**Files:**
- Modify: `tools/seo-geo/audit_summary.py`
- Test: `tools/seo-geo/test_audit_summary.py` (neu)

**Interfaces:**
- Consumes: `gsc.build_authorized_session`, `gsc.report_windows`, `gsc.GSCClient`, `gsc_report.build_site_block/overall_ampel/render_markdown`, `config.load_sites`.
- Produces: `gsc_section(sites_path, environ, today) -> tuple[str, str, list[dict]]` → `(markdown, overall_ampel, blocks)`; fail-soft. In `main()` an den Body angehängt, `<datum>-gsc.json` geschrieben, Betreff/Kopf um GSC-Signal ergänzt.

- [ ] **Step 1: Failing test schreiben** — `test_audit_summary.py`:

```python
import datetime
from audit_summary import gsc_section

def test_gsc_section_ohne_key_ist_failsoft(tmp_path):
    sites = tmp_path / "sites.json"
    sites.write_text('{"report_root":"%s","sites":[{"name":"a","url":"https://a.de",'
                     '"wp_rest_base":"https://a.de/wp-json","credential_ref":"A",'
                     '"crawl_limit":10,"seo_plugin":"yoast"}]}' % tmp_path)
    md, amp, blocks = gsc_section(str(sites), {}, datetime.date(2026, 7, 18))
    assert "nicht konfiguriert" in md
    assert amp == "🟢"
    assert blocks == []
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -v`
Expected: FAIL (`ImportError: cannot import name 'gsc_section'`).

- [ ] **Step 3: `gsc_section` + Integration implementieren** — in `audit_summary.py` ergänzen:

```python
def gsc_section(sites_path, environ, today):
    """Fail-soft: fehlt der SA-Key oder scheitert alles, wird die Onpage-Mail nie gekippt.
    Rückgabe: (markdown, overall_ampel, blocks)."""
    from config import load_sites
    key_file = environ.get("GSC_SA_KEY_FILE")
    if not key_file or not os.path.exists(os.path.expanduser(key_file)):
        return ("\n## Google Search Console\n\nGSC nicht konfiguriert "
                "(GSC_SA_KEY_FILE fehlt) — Onpage-Audit unberührt.\n", "🟢", [])
    try:
        import gsc, gsc_report
        session = gsc.build_authorized_session(os.path.expanduser(key_file))
        client = gsc.GSCClient(session)
        windows = gsc.report_windows(today)
        blocks = [gsc_report.build_site_block(s, client, windows) for s in load_sites(sites_path)]
        return gsc_report.render_markdown(blocks), gsc_report.overall_ampel(blocks), blocks
    except Exception as e:  # niemals die Mail kippen
        return (f"\n## Google Search Console\n\nGSC-Abruf global fehlgeschlagen ({e}).\n", "🟢", [])
```

Am Anfang von `main()` `today` bereits vorhanden (`datetime.date.today()`); direkt nach dem Erzeugen von `body` in `main()` einfügen (vor dem Schreiben von `<date>.md`):

```python
    gsc_md, gsc_amp, gsc_blocks = gsc_section(args.sites, os.environ, today)
    body = body + gsc_md
    if gsc_blocks:
        with open(os.path.join(hist_dir, f"{today}-gsc.json"), "w") as fh:
            json.dump(gsc_blocks, fh, ensure_ascii=False, indent=2)
```

Und die Kopfzeile in `render()` bzw. der Betreff (in `audit-all.sh` wird der Betreff gesetzt) bleiben unverändert; das GSC-Gesamtsignal wird als erste Zeile der GSC-Sektion durch die Ampeln je Site sichtbar. (Betreff-Erweiterung optional in Task 6-Anschluss.)

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -v`
Expected: PASS.

- [ ] **Step 5: Gesamt-Testlauf**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest -q`
Expected: PASS (alle bestehenden + neue Tests grün).

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/audit_summary.py tools/seo-geo/test_audit_summary.py
git commit -m "feat(seo-geo): GSC-Sektion fail-soft in Wochen-Audit-Mail integriert

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: mu-Plugin — `google-site-verification`-Meta-Tag (v0.2.0)

**Files:**
- Modify: `tools/seo-geo/wp-mu-plugin/<pluginfile>.php` (bestehendes mu-Plugin; Header-Version auf `0.2.0`)
- Modify: `tools/seo-geo/wpclient.py` (Setter-Methode), `tools/seo-geo/test_wpclient.py`

**Interfaces:**
- Consumes: bestehendes mu-Plugin-Muster (REST-Route `whitestag-seo-geo/v1/...`, WP-Option).
- Produces:
  - WP-Option `whitestag_gsc_verification` (String-Token), ausgegeben als `<meta name="google-site-verification" content="…">` im `wp_head`, wenn gesetzt.
  - REST-Route `POST /whitestag-seo-geo/v1/gsc-verify` `{ "token": "…" }` (nur mit `manage_options`).
  - `WPClient.set_gsc_verification(token) -> dict`.

- [ ] **Step 1: Failing test schreiben** — `test_wpclient.py` ergänzen:

```python
def test_set_gsc_verification_hits_route():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/whitestag-seo-geo/v1/gsc-verify", json={"ok": True})
        res = _client().set_gsc_verification("81fbff23ab17d859")
        assert res["ok"] is True
        assert m.last_request.json() == {"token": "81fbff23ab17d859"}
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_wpclient.py -k gsc_verification -v`
Expected: FAIL (`AttributeError: 'WPClient' object has no attribute 'set_gsc_verification'`).

- [ ] **Step 3: Client-Methode implementieren** — `wpclient.py` ergänzen:

```python
    def set_gsc_verification(self, token):
        return self._post("/whitestag-seo-geo/v1/gsc-verify", {"token": token})
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_wpclient.py -k gsc_verification -v`
Expected: PASS.

- [ ] **Step 5: mu-Plugin erweitern** — im bestehenden mu-Plugin (analog zur `llms`-Route + Option) ergänzen:

```php
// Version im Plugin-Header auf 0.2.0 setzen.

// Meta-Tag im <head> ausgeben, wenn Token gesetzt.
add_action('wp_head', function () {
    $token = get_option('whitestag_gsc_verification', '');
    if ($token !== '') {
        echo '<meta name="google-site-verification" content="' . esc_attr($token) . '" />' . "\n";
    }
});

// REST-Route zum Setzen des Tokens (nur Administratoren).
add_action('rest_api_init', function () {
    register_rest_route('whitestag-seo-geo/v1', '/gsc-verify', [
        'methods' => 'POST',
        'permission_callback' => function () { return current_user_can('manage_options'); },
        'callback' => function ($req) {
            $token = sanitize_text_field($req->get_param('token'));
            update_option('whitestag_gsc_verification', $token);
            return ['ok' => true];
        },
    ]);
});
```

> Hinweis: Die `gsc-verify`-Route braucht `manage_options` — der `seo-geo-bot` (Redakteur) hat das i.d.R. nicht. Für das einmalige Setzen entweder einen Admin-App-Password nutzen oder das Token direkt in der WP-DB/GUI setzen. Das ist ein **Setup-Schritt**, kein Cron-Pfad.

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/wpclient.py tools/seo-geo/test_wpclient.py tools/seo-geo/wp-mu-plugin/
git commit -m "feat(seo-geo): mu-Plugin v0.2.0 — google-site-verification-Meta-Tag + REST-Setter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Deploy, `sites.json`-Properties, End-to-End-Verifikation

**Files:**
- Modify: `tools/seo-geo/sites.json` (Feld `gsc_property` je Site)

**Interfaces:**
- Consumes: alles aus Tasks 1-5.

- [ ] **Step 1: `gsc_property` in `sites.json` eintragen** — bekannte/verifizierte zuerst (film sicher verifiziert):

```json
{ "name": "whitestag.film", "…": "…", "gsc_property": "https://www.whitestag.film/" }
```

(Für ai/de/vl `gsc_property` erst nach GSC-Verifizierung ergänzen; bis dahin greift Auto-Match bzw. „nicht verifiziert".)

- [ ] **Step 2: Deploy**

Run:
```bash
cd "$(git rev-parse --show-toplevel)"
rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/
~/.paperclip/scripts/seo-geo/venv/bin/pip install -q google-auth==2.34.0
```
Expected: rsync ok, google-auth installiert.

- [ ] **Step 3: Fail-soft-Rauchtest ohne Key**

Run: `cd ~/.paperclip/scripts/seo-geo && ./venv/bin/python audit_summary.py --sites sites.json | tail -20`
Expected: Onpage-Ampel wie bisher **plus** GSC-Sektion mit „GSC nicht konfiguriert" (kein Absturz).

- [ ] **Step 4 (nach Walters Setup): Live-Rauchtest mit Key**

Voraussetzung (Walter): Cloud-Projekt + `GSC_SA_KEY_FILE` gesetzt + SA als GSC-Nutzer je Property; ai/de/vl verifiziert.
Run: `cd ~/.paperclip/scripts/seo-geo && set -a && source ~/.whitestag.env && set +a && ./venv/bin/python audit_summary.py --sites sites.json | tail -30`
Expected: GSC-Block je Site mit echten Klicks/Impressionen + Ampel; nicht verifizierte Sites melden „nicht in GSC".

- [ ] **Step 5: Ganze Routine testen (kickstart)**

Run: `launchctl kickstart -k gui/$(id -u)/ing.whitestag.seo-geo-audit && sleep 90 && tail -40 /tmp/seo-geo-audit.log`
Expected: Lauf endet mit „Mail versendet"; die Mail enthält die GSC-Sektion.

---

## Self-Review

**Spec-Coverage:**
- gsc.py (Client, Totals/Top/Properties, Session-Factory, Zeitfenster) → Task 2 ✓
- gsc_report.py (Delta/Ampel/Movers/Block/Markdown) → Task 3 ✓
- sites.json `gsc_property` + Auto-Match → Task 1 (Feld), Task 3 (resolve), Task 6 (Werte) ✓
- audit_summary-Integration + `<date>-gsc.json` + Betreff-Signal → Task 4 ✓
- Setup (Cloud/SA/Key) → als Voraussetzung dokumentiert (Task 6 Step 4); kein Code ✓
- mu-Plugin-Verifizierungs-Tag für ai/de/vl → Task 5 ✓
- Fail-soft (kein Key / fehlende Property / API-Fehler) → Task 4 (Section), Task 3 (Block-try/except) ✓
- requirements google-auth → Task 2 ✓
- Tests wie `test_*.py`-Muster → jede Kern-Task ✓

**Platzhalter:** keine „TBD/TODO"; jeder Code-Step zeigt vollständigen Code.

**Typ-Konsistenz:** `report_windows` liefert `((ls,le),(ps,pe))`, in Task 3/4 identisch entpackt. `build_site_block`-Dict-Keys (`name, ok, error, cur, prev, deltas, top_queries, top_pages, winners, losers, ampel, property`) durchgängig gleich in Report + Test + Integration. `GSCClient`-Methodennamen (`list_properties/fetch_totals/fetch_top`) identisch in Client, FakeClient, resolve/build.

**Offen (nicht blockierend, im Spec vermerkt):** Betreff-Kombinatorik Onpage+GSC — hier bewusst schlank (GSC-Ampeln je Site sichtbar); eine Betreff-Erweiterung kann später in `audit-all.sh` folgen.
