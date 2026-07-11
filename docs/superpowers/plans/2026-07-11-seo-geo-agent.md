# SEO/GEO-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein dedizierter SEO/GEO-Agent in WHITESTAG lässt WordPress-Sites technisch auditieren, schlägt Metadaten-Änderungen vor und setzt sie nach Walters Freigabe per WordPress-REST-API um — ohne redaktionellen Inhalt anzufassen.

**Architecture:** Ein testbares Python-Tool (`tools/seo-geo/`, deployt nach `~/.paperclip/scripts/seo-geo/`) liefert die Mechanik: `audit` crawlt eine Site und schreibt einen Report, `propose` baut aus Report + Agent-Werten ein Changeset, `approve`/`apply` schreiben freigegebene Whitelist-Felder per WP-REST. Ein serverseitiges mu-Plugin öffnet die Yoast-Meta-Felder für REST und serviert `/llms.txt`. In Phase 2 orchestriert ein Paperclip-Agent das Ganze und eine Routine stößt wöchentliche Audits an.

**Tech Stack:** Python 3.11, `requests`, `beautifulsoup4`, `pytest`, `requests-mock`; WordPress REST-API + Application Passwords; PHP mu-Plugin (Yoast); Paperclip-API.

## Global Constraints

- **Feld-Whitelist (hart im Code):** editierbar sind ausschließlich `seo_title`, `meta_description`, `og_title`, `og_description`, `canonical`, `focus_keyword` (Post/Page-Meta), `alt_text` (Media), `llms_txt` (Site-Option). Alles andere wird im Changeset-Validator abgelehnt.
- **Niemals** Body-Content, Überschriften-Wortlaut, Slugs/URLs, Seiten anlegen/löschen.
- **Kein Live-Write ohne Freigabe:** `apply` verarbeitet nur Changesets aus `approved/`; `propose` legt in `pending/` ab.
- **Auth:** WordPress Application Passwords, Credentials nur aus `~/.whitestag.env`, nie im Repo/Changeset/auf der Site.
- **Ablage-Konvention:** Source + Tests in `tools/seo-geo/` (Git). Laufzeit-Deploy nach `~/.paperclip/scripts/seo-geo/` (launchd kann SynologyDrive nicht lesen).
- **Meta-Längen-Budgets:** `seo_title` ≤ 60 Zeichen, `meta_description` 120–160 Zeichen. Verstöße werden als Warnung im Changeset markiert, nicht hart abgelehnt.
- Alle Tests laufen offline gegen Mocks/Fixtures — nie gegen Live-Domains.
- **Interpreter: Python 3.11+** (System-`python3` ist 3.9 und kann `str | None` (PEP 604) nicht). Entwicklung + Tests laufen über die vorbereitete venv `tools/seo-geo/venv/bin/python`; Deploy-venv wird mit `/opt/homebrew/bin/python3.11` erzeugt. Test-Kommandos in den Tasks (`python -m pytest …`) sind als `./venv/bin/python -m pytest …` auszuführen.

---

## Phase 1 — Python-Dienst (`tools/seo-geo/`)

### Task 1: Projektgerüst + Config-Loader

**Files:**
- Create: `tools/seo-geo/requirements.txt`
- Create: `tools/seo-geo/sites.example.json`
- Create: `tools/seo-geo/config.py`
- Test: `tools/seo-geo/test_config.py`

**Interfaces:**
- Produces: `load_sites(path: str) -> list[Site]` und Dataclass `Site(name, url, wp_rest_base, credential_ref, crawl_limit, seo_plugin)`; `resolve_credential(site: Site, environ: dict) -> tuple[str, str]` liefert `(app_user, app_password)` aus `<credential_ref>_USER` / `<credential_ref>_PW` in der übergebenen Umgebung.

- [ ] **Step 1: requirements.txt anlegen**

```
requests==2.32.3
beautifulsoup4==4.12.3
pytest==8.3.2
requests-mock==1.12.1
```

- [ ] **Step 2: sites.example.json anlegen**

```json
{
  "report_root": "~/.paperclip/seo-geo",
  "sites": [
    {
      "name": "whitestag.ai",
      "url": "https://whitestag.ai",
      "wp_rest_base": "https://whitestag.ai/wp-json",
      "credential_ref": "WHITESTAG_AI_WP",
      "crawl_limit": 200,
      "seo_plugin": "yoast"
    }
  ]
}
```

- [ ] **Step 3: Failing test schreiben**

```python
# test_config.py
import json, pathlib
from config import load_sites, resolve_credential

def test_load_sites_parses_entries(tmp_path):
    p = tmp_path / "sites.json"
    p.write_text(json.dumps({"report_root": "/tmp/r", "sites": [{
        "name": "x", "url": "https://x.de", "wp_rest_base": "https://x.de/wp-json",
        "credential_ref": "X_WP", "crawl_limit": 50, "seo_plugin": "yoast"}]}))
    sites = load_sites(str(p))
    assert sites[0].name == "x"
    assert sites[0].crawl_limit == 50

def test_resolve_credential_reads_env():
    from config import Site
    s = Site(name="x", url="https://x.de", wp_rest_base="https://x.de/wp-json",
             credential_ref="X_WP", crawl_limit=50, seo_plugin="yoast")
    user, pw = resolve_credential(s, {"X_WP_USER": "bot", "X_WP_PW": "abcd efgh"})
    assert (user, pw) == ("bot", "abcd efgh")
```

- [ ] **Step 4: Test laufen lassen (erwartet FAIL: `No module named 'config'`)**

Run: `cd tools/seo-geo && python -m pytest test_config.py -v`

- [ ] **Step 5: config.py implementieren**

```python
# config.py
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

def load_sites(path: str) -> list[Site]:
    data = json.loads(open(os.path.expanduser(path)).read())
    return [Site(**{k: s[k] for k in
                    ("name", "url", "wp_rest_base", "credential_ref", "crawl_limit", "seo_plugin")})
            for s in data["sites"]]

def resolve_credential(site: Site, environ: dict) -> tuple[str, str]:
    ref = site.credential_ref
    try:
        return environ[f"{ref}_USER"], environ[f"{ref}_PW"]
    except KeyError as e:
        raise RuntimeError(f"Fehlende Credential-Env-Variable: {e}") from e
```

- [ ] **Step 6: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_config.py -v`

- [ ] **Step 7: Commit**

```bash
git add tools/seo-geo/requirements.txt tools/seo-geo/sites.example.json tools/seo-geo/config.py tools/seo-geo/test_config.py
git commit -m "feat(seo-geo): Projektgerüst + Config-Loader"
```

---

### Task 2: Onpage-Signal-Parser

**Files:**
- Create: `tools/seo-geo/crawl.py`
- Test: `tools/seo-geo/test_crawl.py`

**Interfaces:**
- Consumes: nichts.
- Produces: `parse_page(url: str, html: str) -> PageSignals` mit Dataclass `PageSignals(url, title, meta_description, og_title, og_description, canonical, h1_count, images_total, images_missing_alt, jsonld_types: list[str])`.

- [ ] **Step 1: Failing test schreiben**

```python
# test_crawl.py
from crawl import parse_page

HTML = """
<html><head>
<title>Beispielseite</title>
<meta name="description" content="Kurze Beschreibung.">
<meta property="og:title" content="OG Titel">
<link rel="canonical" href="https://x.de/seite">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body>
<h1>Titel</h1>
<img src="a.jpg" alt="hat alt">
<img src="b.jpg">
</body></html>
"""

def test_parse_extracts_core_signals():
    s = parse_page("https://x.de/seite", HTML)
    assert s.title == "Beispielseite"
    assert s.meta_description == "Kurze Beschreibung."
    assert s.og_title == "OG Titel"
    assert s.canonical == "https://x.de/seite"
    assert s.h1_count == 1
    assert s.images_total == 2
    assert s.images_missing_alt == 1
    assert s.jsonld_types == ["Organization"]

def test_parse_handles_missing_fields():
    s = parse_page("https://x.de/leer", "<html><head></head><body></body></html>")
    assert s.title is None
    assert s.meta_description is None
    assert s.images_total == 0
    assert s.jsonld_types == []
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_crawl.py -v`

- [ ] **Step 3: crawl.py implementieren**

```python
# crawl.py
import json
from dataclasses import dataclass, field
from bs4 import BeautifulSoup

@dataclass
class PageSignals:
    url: str
    title: str | None = None
    meta_description: str | None = None
    og_title: str | None = None
    og_description: str | None = None
    canonical: str | None = None
    h1_count: int = 0
    images_total: int = 0
    images_missing_alt: int = 0
    jsonld_types: list[str] = field(default_factory=list)

def _meta(soup, **attrs):
    tag = soup.find("meta", attrs=attrs)
    return tag.get("content").strip() if tag and tag.get("content") else None

def parse_page(url: str, html: str) -> PageSignals:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text().strip() if soup.title else None
    canonical_tag = soup.find("link", rel="canonical")
    imgs = soup.find_all("img")
    types = []
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.get_text())
        except (ValueError, TypeError):
            continue
        for node in (data if isinstance(data, list) else [data]):
            t = node.get("@type") if isinstance(node, dict) else None
            if isinstance(t, str):
                types.append(t)
    return PageSignals(
        url=url,
        title=title,
        meta_description=_meta(soup, name="description"),
        og_title=_meta(soup, property="og:title"),
        og_description=_meta(soup, property="og:description"),
        canonical=canonical_tag.get("href").strip() if canonical_tag and canonical_tag.get("href") else None,
        h1_count=len(soup.find_all("h1")),
        images_total=len(imgs),
        images_missing_alt=sum(1 for i in imgs if not i.get("alt", "").strip()),
        jsonld_types=types,
    )
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_crawl.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/crawl.py tools/seo-geo/test_crawl.py
git commit -m "feat(seo-geo): Onpage-Signal-Parser"
```

---

### Task 3: Findings-Regeln (Report-Logik)

**Files:**
- Create: `tools/seo-geo/findings.py`
- Test: `tools/seo-geo/test_findings.py`

**Interfaces:**
- Consumes: `PageSignals` aus Task 2.
- Produces: `evaluate_page(sig: PageSignals) -> list[Finding]` mit `Finding(url, field, severity, issue)`; `severity ∈ {"high","medium","low"}`. Regeln: fehlender Title/Description → high; Title > 60 / Description außerhalb 120–160 → medium; fehlendes OG → low; `h1_count != 1` → medium; `images_missing_alt > 0` → medium; kein JSON-LD → low.

- [ ] **Step 1: Failing test schreiben**

```python
# test_findings.py
from crawl import PageSignals
from findings import evaluate_page

def _fields(findings):
    return {(f.field, f.severity) for f in findings}

def test_missing_title_and_description_are_high():
    sig = PageSignals(url="https://x.de/a", h1_count=1)
    fields = _fields(evaluate_page(sig))
    assert ("seo_title", "high") in fields
    assert ("meta_description", "high") in fields

def test_length_violations_are_medium():
    sig = PageSignals(url="https://x.de/b", title="x"*70,
                      meta_description="y"*80, og_title="o", og_description="o",
                      h1_count=1, jsonld_types=["WebPage"])
    fields = _fields(evaluate_page(sig))
    assert ("seo_title", "medium") in fields
    assert ("meta_description", "medium") in fields

def test_clean_page_has_no_findings():
    sig = PageSignals(url="https://x.de/c", title="Guter Titel",
                      meta_description="d"*140, og_title="o", og_description="o",
                      canonical="https://x.de/c", h1_count=1, images_total=0,
                      images_missing_alt=0, jsonld_types=["WebPage"])
    assert evaluate_page(sig) == []
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_findings.py -v`

- [ ] **Step 3: findings.py implementieren**

```python
# findings.py
from dataclasses import dataclass
from crawl import PageSignals

@dataclass
class Finding:
    url: str
    field: str
    severity: str
    issue: str

def evaluate_page(sig: PageSignals) -> list[Finding]:
    out: list[Finding] = []
    def add(field, sev, issue): out.append(Finding(sig.url, field, sev, issue))

    if not sig.title:
        add("seo_title", "high", "Kein Title vorhanden")
    elif len(sig.title) > 60:
        add("seo_title", "medium", f"Title zu lang ({len(sig.title)} > 60)")

    if not sig.meta_description:
        add("meta_description", "high", "Keine Meta-Description")
    elif not (120 <= len(sig.meta_description) <= 160):
        add("meta_description", "medium",
            f"Description-Länge {len(sig.meta_description)} außerhalb 120–160")

    if not sig.og_title:
        add("og_title", "low", "Kein og:title")
    if not sig.og_description:
        add("og_description", "low", "Kein og:description")
    if sig.h1_count != 1:
        add("h1", "medium", f"{sig.h1_count} H1-Überschriften (soll: genau 1)")
    if sig.images_missing_alt > 0:
        add("alt_text", "medium", f"{sig.images_missing_alt} Bilder ohne Alt-Text")
    if not sig.jsonld_types:
        add("schema", "low", "Kein JSON-LD/Schema gefunden")
    return out
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_findings.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/findings.py tools/seo-geo/test_findings.py
git commit -m "feat(seo-geo): Findings-Regeln"
```

---

### Task 4: Audit-Orchestrierung (Crawl → Report)

**Files:**
- Create: `tools/seo-geo/audit.py`
- Test: `tools/seo-geo/test_audit.py`

**Interfaces:**
- Consumes: `Site` (Task 1), `parse_page` (Task 2), `evaluate_page` (Task 3).
- Produces: `run_audit(site, fetch, sitemap_urls) -> AuditReport` mit `AuditReport(site_name, pages: list[PageSignals], findings: list[Finding], site_level: dict)`; `fetch(url) -> str` ist injizierbar (Test-Mock). `write_report(report, report_root) -> tuple[str, str]` schreibt `report.json` + `report.md` und liefert deren Pfade. Site-Level prüft `llms_txt_present: bool` (via `fetch(url + "/llms.txt")`).

- [ ] **Step 1: Failing test schreiben**

```python
# test_audit.py
import json
from config import Site
from audit import run_audit, write_report

SITE = Site("x", "https://x.de", "https://x.de/wp-json", "X_WP", 10, "yoast")

def _fetch_factory(pages, llms=""):
    def fetch(url):
        if url.endswith("/llms.txt"):
            return llms
        return pages[url]
    return fetch

def test_run_audit_collects_pages_and_findings():
    pages = {"https://x.de/a": "<html><head></head><body></body></html>"}
    report = run_audit(SITE, _fetch_factory(pages), ["https://x.de/a"])
    assert report.site_name == "x"
    assert len(report.pages) == 1
    assert any(f.field == "seo_title" for f in report.findings)
    assert report.site_level["llms_txt_present"] is False

def test_run_audit_respects_crawl_limit():
    urls = [f"https://x.de/{i}" for i in range(20)]
    pages = {u: "<html></html>" for u in urls}
    small = Site("x", "https://x.de", "https://x.de/wp-json", "X_WP", 5, "yoast")
    report = run_audit(small, _fetch_factory(pages), urls)
    assert len(report.pages) == 5

def test_write_report_emits_json_and_md(tmp_path):
    pages = {"https://x.de/a": "<html><head></head><body></body></html>"}
    report = run_audit(SITE, _fetch_factory(pages), ["https://x.de/a"])
    jpath, mpath = write_report(report, str(tmp_path))
    data = json.loads(open(jpath).read())
    assert data["site_name"] == "x"
    assert "## Findings" in open(mpath).read()
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_audit.py -v`

- [ ] **Step 3: audit.py implementieren**

```python
# audit.py
import json, os
from dataclasses import dataclass, asdict
from crawl import parse_page, PageSignals
from findings import evaluate_page, Finding

@dataclass
class AuditReport:
    site_name: str
    pages: list
    findings: list
    site_level: dict

def run_audit(site, fetch, sitemap_urls) -> AuditReport:
    pages, findings = [], []
    for url in sitemap_urls[: site.crawl_limit]:
        sig = parse_page(url, fetch(url))
        pages.append(sig)
        findings.extend(evaluate_page(sig))
    llms = ""
    try:
        llms = fetch(site.url.rstrip("/") + "/llms.txt")
    except Exception:
        llms = ""
    site_level = {"llms_txt_present": bool(llms and llms.strip().startswith("#"))}
    return AuditReport(site.name, pages, findings, site_level)

def write_report(report: AuditReport, report_root: str):
    root = os.path.expanduser(report_root)
    site_dir = os.path.join(root, report.site_name)
    os.makedirs(site_dir, exist_ok=True)
    jpath = os.path.join(site_dir, "report.json")
    mpath = os.path.join(site_dir, "report.md")
    payload = {
        "site_name": report.site_name,
        "site_level": report.site_level,
        "pages": [asdict(p) for p in report.pages],
        "findings": [asdict(f) for f in report.findings],
    }
    with open(jpath, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    lines = [f"# SEO/GEO-Audit: {report.site_name}", "",
             f"llms.txt vorhanden: {report.site_level['llms_txt_present']}", "",
             "## Findings", ""]
    for f in sorted(report.findings, key=lambda x: {"high":0,"medium":1,"low":2}[x.severity]):
        lines.append(f"- [{f.severity.upper()}] {f.url} — {f.field}: {f.issue}")
    with open(mpath, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return jpath, mpath
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_audit.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/audit.py tools/seo-geo/test_audit.py
git commit -m "feat(seo-geo): Audit-Orchestrierung + Report-Ausgabe"
```

---

### Task 5: Changeset-Bau + Whitelist-Validierung

**Files:**
- Create: `tools/seo-geo/changeset.py`
- Test: `tools/seo-geo/test_changeset.py`

**Interfaces:**
- Consumes: nichts (arbeitet auf Dicts, damit der Agent Werte liefern kann).
- Produces: Konstante `EDITABLE_FIELDS: set[str]`; `validate_change(change: dict) -> list[str]` (Liste von Fehlermeldungen, leer = ok); `build_changeset(site_name, changes: list[dict]) -> dict` erzeugt `{"site": ..., "changes": [...]}` und wirft `ValueError`, wenn eine Änderung ein Feld außerhalb `EDITABLE_FIELDS` betrifft. Jede Change: `{"target": "post"|"media"|"site", "id": int|None, "field": str, "old": Any, "new": Any}`.

- [ ] **Step 1: Failing test schreiben**

```python
# test_changeset.py
import pytest
from changeset import EDITABLE_FIELDS, validate_change, build_changeset

def test_editable_fields_are_locked():
    assert EDITABLE_FIELDS == {
        "seo_title", "meta_description", "og_title", "og_description",
        "canonical", "focus_keyword", "alt_text", "llms_txt"}

def test_build_rejects_non_whitelisted_field():
    with pytest.raises(ValueError):
        build_changeset("x", [{"target":"post","id":1,"field":"body","old":"a","new":"b"}])

def test_build_accepts_whitelisted_change():
    cs = build_changeset("x", [{"target":"post","id":1,"field":"seo_title",
                                "old":None,"new":"Neuer Titel"}])
    assert cs["site"] == "x"
    assert cs["changes"][0]["field"] == "seo_title"

def test_validate_flags_length_budget():
    warns = validate_change({"target":"post","id":1,"field":"seo_title",
                             "old":None,"new":"z"*70})
    assert any("60" in w for w in warns)
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_changeset.py -v`

- [ ] **Step 3: changeset.py implementieren**

```python
# changeset.py
EDITABLE_FIELDS = {
    "seo_title", "meta_description", "og_title", "og_description",
    "canonical", "focus_keyword", "alt_text", "llms_txt",
}

def validate_change(change: dict) -> list[str]:
    warns: list[str] = []
    field, new = change.get("field"), change.get("new")
    if field == "seo_title" and isinstance(new, str) and len(new) > 60:
        warns.append(f"seo_title {len(new)} Zeichen > 60")
    if field == "meta_description" and isinstance(new, str) and not (120 <= len(new) <= 160):
        warns.append(f"meta_description {len(new)} Zeichen außerhalb 120–160")
    return warns

def build_changeset(site_name: str, changes: list[dict]) -> dict:
    for c in changes:
        if c.get("field") not in EDITABLE_FIELDS:
            raise ValueError(f"Feld nicht in Whitelist: {c.get('field')}")
    return {"site": site_name, "changes": changes}
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_changeset.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/changeset.py tools/seo-geo/test_changeset.py
git commit -m "feat(seo-geo): Changeset-Bau + Whitelist-Validierung"
```

---

### Task 6: WordPress-REST-Client

**Files:**
- Create: `tools/seo-geo/wpclient.py`
- Test: `tools/seo-geo/test_wpclient.py`

**Interfaces:**
- Consumes: nichts (bekommt `wp_rest_base`, `auth=(user, pw)` injiziert).
- Produces: Klasse `WPClient(rest_base, auth, session=None)` mit
  `get_post_meta(post_id) -> dict`,
  `set_yoast_meta(post_id, field, value) -> dict` (mappt `seo_title→_yoast_wpseo_title`, `meta_description→_yoast_wpseo_metadesc`, `og_title→_yoast_wpseo_opengraph-title`, `og_description→_yoast_wpseo_opengraph-description`, `canonical→_yoast_wpseo_canonical`, `focus_keyword→_yoast_wpseo_focuskw`; POST auf `/wp/v2/posts/<id>` bzw. `/pages/<id>` mit `{"meta": {...}}`),
  `set_alt_text(media_id, value) -> dict` (POST `/wp/v2/media/<id>` mit `{"alt_text": ...}`),
  `set_llms_txt(value) -> dict` (POST `/whitestag-seo-geo/v1/llms` mit `{"content": ...}`). Tests nutzen `requests_mock`.

- [ ] **Step 1: Failing test schreiben**

```python
# test_wpclient.py
import requests, requests_mock
from wpclient import WPClient

BASE = "https://x.de/wp-json"

def _client():
    return WPClient(BASE, auth=("bot", "pw"))

def test_set_yoast_meta_maps_field_and_posts():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/wp/v2/posts/12",
               json={"id": 12, "meta": {"_yoast_wpseo_title": "Neu"}})
        res = _client().set_yoast_meta(12, "seo_title", "Neu")
        assert res["meta"]["_yoast_wpseo_title"] == "Neu"
        assert m.last_request.json() == {"meta": {"_yoast_wpseo_title": "Neu"}}

def test_set_alt_text_posts_media():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/wp/v2/media/7", json={"id": 7, "alt_text": "Bild"})
        res = _client().set_alt_text(7, "Bild")
        assert res["alt_text"] == "Bild"

def test_set_llms_txt_hits_custom_route():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/whitestag-seo-geo/v1/llms", json={"ok": True})
        res = _client().set_llms_txt("# Site\n")
        assert res["ok"] is True
        assert m.last_request.json() == {"content": "# Site\n"}
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_wpclient.py -v`

- [ ] **Step 3: wpclient.py implementieren**

```python
# wpclient.py
import requests

_YOAST_MAP = {
    "seo_title": "_yoast_wpseo_title",
    "meta_description": "_yoast_wpseo_metadesc",
    "og_title": "_yoast_wpseo_opengraph-title",
    "og_description": "_yoast_wpseo_opengraph-description",
    "canonical": "_yoast_wpseo_canonical",
    "focus_keyword": "_yoast_wpseo_focuskw",
}

class WPClient:
    def __init__(self, rest_base, auth, session=None):
        self.base = rest_base.rstrip("/")
        self.auth = auth
        self.http = session or requests.Session()

    def _post(self, path, payload):
        r = self.http.post(f"{self.base}{path}", json=payload, auth=self.auth, timeout=30)
        r.raise_for_status()
        return r.json()

    def get_post_meta(self, post_id):
        r = self.http.get(f"{self.base}/wp/v2/posts/{post_id}", auth=self.auth, timeout=30)
        r.raise_for_status()
        return r.json().get("meta", {})

    def set_yoast_meta(self, post_id, field, value):
        key = _YOAST_MAP[field]
        return self._post(f"/wp/v2/posts/{post_id}", {"meta": {key: value}})

    def set_alt_text(self, media_id, value):
        return self._post(f"/wp/v2/media/{media_id}", {"alt_text": value})

    def set_llms_txt(self, value):
        return self._post("/whitestag-seo-geo/v1/llms", {"content": value})
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_wpclient.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/wpclient.py tools/seo-geo/test_wpclient.py
git commit -m "feat(seo-geo): WordPress-REST-Client (Yoast/Media/llms)"
```

---

### Task 7: Apply-Engine mit Vorher/Nachher-Log

**Files:**
- Create: `tools/seo-geo/apply.py`
- Test: `tools/seo-geo/test_apply.py`

**Interfaces:**
- Consumes: `WPClient` (Task 6), Changeset-Dict (Task 5).
- Produces: `apply_changeset(changeset, client, dry_run=False) -> ApplyLog` mit `ApplyLog(applied: list[dict], skipped: list[dict])`. Routing nach `target`: `post`→`set_yoast_meta`, `media`→`set_alt_text`, `site`+`field=="llms_txt"`→`set_llms_txt`. Bei `dry_run=True` wird nichts geschrieben, alle Changes landen in `skipped` mit Grund `"dry-run"`. Jeder applied-Eintrag speichert `old` für Rollback.

- [ ] **Step 1: Failing test schreiben**

```python
# test_apply.py
from apply import apply_changeset

class FakeClient:
    def __init__(self): self.calls = []
    def set_yoast_meta(self, pid, field, value): self.calls.append(("yoast", pid, field, value)); return {}
    def set_alt_text(self, mid, value): self.calls.append(("alt", mid, value)); return {}
    def set_llms_txt(self, value): self.calls.append(("llms", value)); return {}

CS = {"site": "x", "changes": [
    {"target":"post","id":1,"field":"seo_title","old":"Alt","new":"Neu"},
    {"target":"media","id":7,"field":"alt_text","old":"","new":"Bild"},
    {"target":"site","id":None,"field":"llms_txt","old":"","new":"# X\n"},
]}

def test_apply_routes_and_logs():
    c = FakeClient()
    log = apply_changeset(CS, c)
    assert ("yoast", 1, "seo_title", "Neu") in c.calls
    assert ("alt", 7, "Bild") in c.calls
    assert ("llms", "# X\n") in c.calls
    assert len(log.applied) == 3
    assert log.applied[0]["old"] == "Alt"

def test_dry_run_writes_nothing():
    c = FakeClient()
    log = apply_changeset(CS, c, dry_run=True)
    assert c.calls == []
    assert len(log.skipped) == 3
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_apply.py -v`

- [ ] **Step 3: apply.py implementieren**

```python
# apply.py
from dataclasses import dataclass, field

@dataclass
class ApplyLog:
    applied: list = field(default_factory=list)
    skipped: list = field(default_factory=list)

def apply_changeset(changeset, client, dry_run=False) -> ApplyLog:
    log = ApplyLog()
    for c in changeset["changes"]:
        if dry_run:
            log.skipped.append({**c, "reason": "dry-run"})
            continue
        target, fld = c["target"], c["field"]
        if target == "post":
            client.set_yoast_meta(c["id"], fld, c["new"])
        elif target == "media":
            client.set_alt_text(c["id"], c["new"])
        elif target == "site" and fld == "llms_txt":
            client.set_llms_txt(c["new"])
        else:
            log.skipped.append({**c, "reason": f"unbekanntes target/field {target}/{fld}"})
            continue
        log.applied.append({**c})
    return log
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_apply.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/apply.py tools/seo-geo/test_apply.py
git commit -m "feat(seo-geo): Apply-Engine mit dry-run + Vorher/Nachher-Log"
```

---

### Task 8: CLI + Freigabe-Ordnerlogik

**Files:**
- Create: `tools/seo-geo/cli.py`
- Test: `tools/seo-geo/test_cli.py`

**Interfaces:**
- Consumes: alle vorherigen Module.
- Produces: `main(argv, environ, fetch=None, client_factory=None) -> int` mit Sub-Kommandos:
  - `audit --site NAME --sites PATH` → schreibt Report.
  - `approve --changeset PATH --root ROOT` → verschiebt Datei von `pending/` nach `approved/`.
  - `apply --site NAME --sites PATH --root ROOT [--dry-run]` → liest jedes Changeset in `approved/`, wendet an, schreibt `apply-log.json`, verschiebt nach `applied/`.
  - Ordner-Layout unter `report_root/<site>/`: `pending/`, `approved/`, `applied/`. `fetch`/`client_factory` injizierbar für Tests.

- [ ] **Step 1: Failing test schreiben**

```python
# test_cli.py
import json, os
from cli import main

def _write_sites(tmp_path):
    p = tmp_path / "sites.json"
    p.write_text(json.dumps({"report_root": str(tmp_path/"r"), "sites": [{
        "name":"x","url":"https://x.de","wp_rest_base":"https://x.de/wp-json",
        "credential_ref":"X_WP","crawl_limit":10,"seo_plugin":"yoast"}]}))
    return str(p)

def test_approve_moves_pending_to_approved(tmp_path):
    root = tmp_path / "r" / "x"
    (root / "pending").mkdir(parents=True)
    cs = root / "pending" / "cs1.json"
    cs.write_text(json.dumps({"site":"x","changes":[]}))
    rc = main(["approve","--changeset",str(cs),"--root",str(tmp_path/"r")], {})
    assert rc == 0
    assert (root / "approved" / "cs1.json").exists()
    assert not cs.exists()

def test_apply_consumes_approved(tmp_path):
    sites = _write_sites(tmp_path)
    root = tmp_path / "r" / "x"
    (root / "approved").mkdir(parents=True)
    (root / "approved" / "cs1.json").write_text(json.dumps(
        {"site":"x","changes":[{"target":"post","id":1,"field":"seo_title","old":"a","new":"b"}]}))
    calls = []
    class C:
        def set_yoast_meta(self,*a): calls.append(a); return {}
    rc = main(["apply","--site","x","--sites",sites,"--root",str(tmp_path/"r")],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda site,auth: C())
    assert rc == 0
    assert calls == [(1,"seo_title","b")]
    assert (root / "applied" / "cs1.json").exists()
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_cli.py -v`

- [ ] **Step 3: cli.py implementieren**

```python
# cli.py
import argparse, json, os, shutil
from dataclasses import asdict
from config import load_sites, resolve_credential
from apply import apply_changeset

def _site_dir(root, name):
    return os.path.join(os.path.expanduser(root), name)

def _default_client_factory(site, auth):
    from wpclient import WPClient
    return WPClient(site.wp_rest_base, auth)

def _cmd_approve(args, environ):
    src = args.changeset
    dst_dir = os.path.join(os.path.dirname(os.path.dirname(src)), "approved")
    os.makedirs(dst_dir, exist_ok=True)
    shutil.move(src, os.path.join(dst_dir, os.path.basename(src)))
    return 0

def _cmd_apply(args, environ, client_factory):
    site = next(s for s in load_sites(args.sites) if s.name == args.site)
    auth = resolve_credential(site, environ)
    client = client_factory(site, auth)
    sdir = _site_dir(args.root, site.name)
    approved = os.path.join(sdir, "approved")
    applied = os.path.join(sdir, "applied")
    os.makedirs(applied, exist_ok=True)
    for fn in sorted(os.listdir(approved)) if os.path.isdir(approved) else []:
        path = os.path.join(approved, fn)
        cs = json.loads(open(path).read())
        log = apply_changeset(cs, client, dry_run=args.dry_run)
        with open(os.path.join(sdir, "apply-log.json"), "w") as fh:
            json.dump(asdict(log), fh, ensure_ascii=False, indent=2)
        if not args.dry_run:
            shutil.move(path, os.path.join(applied, fn))
    return 0

def _cmd_audit(args, environ, fetch):
    from audit import run_audit, write_report
    from sitemap import fetch_sitemap_urls  # Task 9
    site = next(s for s in load_sites(args.sites) if s.name == args.site)
    fetch = fetch or _http_fetch
    urls = fetch_sitemap_urls(site, fetch)
    report = run_audit(site, fetch, urls)
    data = json.loads(open(args.sites).read())
    write_report(report, data.get("report_root", "~/.paperclip/seo-geo"))
    return 0

def _http_fetch(url):
    import requests
    r = requests.get(url, timeout=30); r.raise_for_status()
    return r.text

def main(argv, environ, fetch=None, client_factory=None) -> int:
    client_factory = client_factory or _default_client_factory
    p = argparse.ArgumentParser(prog="seo-geo")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("audit"); a.add_argument("--site"); a.add_argument("--sites")
    ap = sub.add_parser("approve"); ap.add_argument("--changeset"); ap.add_argument("--root")
    apl = sub.add_parser("apply"); apl.add_argument("--site"); apl.add_argument("--sites")
    apl.add_argument("--root"); apl.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)
    if args.cmd == "approve": return _cmd_approve(args, environ)
    if args.cmd == "apply": return _cmd_apply(args, environ, client_factory)
    if args.cmd == "audit": return _cmd_audit(args, environ, fetch)
    return 1

if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:], os.environ))
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)** — Hinweis: `test_cli.py` deckt `approve` + `apply` ab; `audit` wird in Task 9 end-to-end getestet.

Run: `cd tools/seo-geo && python -m pytest test_cli.py -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/cli.py tools/seo-geo/test_cli.py
git commit -m "feat(seo-geo): CLI + Freigabe-Ordnerlogik (pending/approved/applied)"
```

---

### Task 9: Sitemap-Discovery

**Files:**
- Create: `tools/seo-geo/sitemap.py`
- Test: `tools/seo-geo/test_sitemap.py`

**Interfaces:**
- Consumes: `Site` (Task 1), `fetch` (injiziert).
- Produces: `fetch_sitemap_urls(site, fetch) -> list[str]`. Liest `site.url + "/sitemap.xml"` (bzw. `sitemap_index.xml`), folgt Sub-Sitemaps eine Ebene tief, dedupliziert, kappt bei `crawl_limit`.

- [ ] **Step 1: Failing test schreiben**

```python
# test_sitemap.py
from config import Site
from sitemap import fetch_sitemap_urls

SITE = Site("x","https://x.de","https://x.de/wp-json","X_WP",100,"yoast")

INDEX = """<sitemapindex><sitemap><loc>https://x.de/post-sitemap.xml</loc></sitemap></sitemapindex>"""
POSTS = """<urlset><url><loc>https://x.de/a</loc></url><url><loc>https://x.de/b</loc></url></urlset>"""

def test_follows_index_to_urls():
    resp = {"https://x.de/sitemap.xml": INDEX, "https://x.de/post-sitemap.xml": POSTS}
    urls = fetch_sitemap_urls(SITE, lambda u: resp[u])
    assert urls == ["https://x.de/a", "https://x.de/b"]

def test_plain_urlset():
    resp = {"https://x.de/sitemap.xml": POSTS}
    urls = fetch_sitemap_urls(SITE, lambda u: resp[u])
    assert set(urls) == {"https://x.de/a", "https://x.de/b"}
```

- [ ] **Step 2: Test laufen lassen (erwartet FAIL)**

Run: `cd tools/seo-geo && python -m pytest test_sitemap.py -v`

- [ ] **Step 3: sitemap.py implementieren**

```python
# sitemap.py
import re

def _locs(xml): return re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml)

def fetch_sitemap_urls(site, fetch) -> list[str]:
    root = site.url.rstrip("/") + "/sitemap.xml"
    xml = fetch(root)
    locs = _locs(xml)
    if "<sitemapindex" in xml:
        urls = []
        for sub in locs:
            urls.extend(_locs(fetch(sub)))
    else:
        urls = locs
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u); out.append(u)
    return out[: site.crawl_limit]
```

- [ ] **Step 4: Test laufen lassen (erwartet PASS)**

Run: `cd tools/seo-geo && python -m pytest test_sitemap.py -v && python -m pytest -v`

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/sitemap.py tools/seo-geo/test_sitemap.py
git commit -m "feat(seo-geo): Sitemap-Discovery"
```

---

### Task 10: WordPress mu-Plugin (serverseitig)

**Files:**
- Create: `tools/seo-geo/wp-mu-plugin/whitestag-seo-geo.php`
- Create: `tools/seo-geo/wp-mu-plugin/README.md`

**Interfaces:**
- Öffnet die Yoast-Meta-Keys aus `_YOAST_MAP` (Task 6) für REST (`register_post_meta` mit `show_in_rest`, `auth_callback` = `edit_posts`), registriert die Route `POST /whitestag-seo-geo/v1/llms` (speichert Option `whitestag_llms_txt`) und serviert `/llms.txt` aus dieser Option. Kein Unit-Test — manueller Installations-/Smoke-Test in Task 12.

- [ ] **Step 1: PHP-Plugin schreiben**

```php
<?php
/*
Plugin Name: WHITESTAG SEO/GEO Bridge
Description: Öffnet Yoast-Meta für REST + serviert /llms.txt aus einer Option.
Version: 0.1.0
*/
if (!defined('ABSPATH')) exit;

add_action('init', function () {
    $keys = [
        '_yoast_wpseo_title', '_yoast_wpseo_metadesc',
        '_yoast_wpseo_opengraph-title', '_yoast_wpseo_opengraph-description',
        '_yoast_wpseo_canonical', '_yoast_wpseo_focuskw',
    ];
    foreach (['post', 'page'] as $type) {
        foreach ($keys as $key) {
            register_post_meta($type, $key, [
                'show_in_rest' => true,
                'single'       => true,
                'type'         => 'string',
                'auth_callback'=> function () { return current_user_can('edit_posts'); },
            ]);
        }
    }
});

add_action('rest_api_init', function () {
    register_rest_route('whitestag-seo-geo/v1', '/llms', [
        'methods'  => 'POST',
        'permission_callback' => function () { return current_user_can('manage_options'); },
        'callback' => function ($req) {
            update_option('whitestag_llms_txt', (string) $req->get_param('content'));
            return ['ok' => true];
        },
    ]);
});

add_action('init', function () {
    if (isset($_SERVER['REQUEST_URI']) && strtok($_SERVER['REQUEST_URI'], '?') === '/llms.txt') {
        $c = get_option('whitestag_llms_txt', '');
        if ($c !== '') {
            header('Content-Type: text/plain; charset=utf-8');
            echo $c; exit;
        }
    }
});
```

- [ ] **Step 2: README.md schreiben (Installation)**

````markdown
# WHITESTAG SEO/GEO Bridge (mu-plugin)

Pro WordPress-Site installieren:

1. Datei nach `wp-content/mu-plugins/whitestag-seo-geo.php` kopieren
   (Ordner ggf. anlegen — mu-plugins sind immer aktiv, kein Aktivieren nötig).
2. Unter **Benutzer → Profil → Application Passwords** ein Passwort für den
   Bot-User erzeugen; User + Passwort in `~/.whitestag.env` als
   `<CREDENTIAL_REF>_USER` / `<CREDENTIAL_REF>_PW` hinterlegen.
3. Smoke-Test:
   ```
   curl -u "bot:app pw" -X POST https://SITE/wp-json/whitestag-seo-geo/v1/llms \
     -H "Content-Type: application/json" -d '{"content":"# Test\n"}'
   curl https://SITE/llms.txt
   ```
````

- [ ] **Step 3: Commit**

```bash
git add tools/seo-geo/wp-mu-plugin/
git commit -m "feat(seo-geo): WordPress mu-Plugin (Yoast-REST + /llms.txt)"
```

---

### Task 11: Deploy-Artefakte (launchd + DEPLOY.md)

**Files:**
- Create: `tools/seo-geo/ing.whitestag.seo-geo-audit.plist`
- Create: `tools/seo-geo/DEPLOY.md`

**Interfaces:** keine (Ops-Artefakte). Muster: `tools/n8n-workflow-watcher/DEPLOY.md` + dessen `.plist`.

- [ ] **Step 1: launchd-Plist schreiben (wöchentliches Audit, Mo 05:00)**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ing.whitestag.seo-geo-audit</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/.paperclip/scripts/seo-geo &amp;&amp; source ~/.whitestag.env &amp;&amp; ./venv/bin/python cli.py audit --site whitestag.ai --sites sites.json</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/seo-geo-audit.log</string>
  <key>StandardErrorPath</key><string>/tmp/seo-geo-audit.err</string>
</dict></plist>
```

- [ ] **Step 2: DEPLOY.md schreiben**

````markdown
# Deploy: seo-geo-dienst

Source lebt in `tools/seo-geo/` (Git). Laufzeit unter `~/.paperclip/scripts/seo-geo/`
(launchd kann SynologyDrive nicht lesen).

## Erstinstallation
```bash
mkdir -p ~/.paperclip/scripts/seo-geo
rsync -a --exclude venv --exclude __pycache__ --exclude '.pytest_cache' \
  "tools/seo-geo/" ~/.paperclip/scripts/seo-geo/
cd ~/.paperclip/scripts/seo-geo
/opt/homebrew/bin/python3.11 -m venv venv && ./venv/bin/pip install -r requirements.txt
cp sites.example.json sites.json   # echte Domains + credential_ref eintragen
cp ing.whitestag.seo-geo-audit.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ing.whitestag.seo-geo-audit.plist
```

## Credentials
`~/.whitestag.env` je Site: `WHITESTAG_AI_WP_USER`, `WHITESTAG_AI_WP_PW`
(WordPress Application Password).

## Update nach Code-Änderung
`rsync` erneut ausführen; bei geänderter Plist `launchctl unload`+`load`.

## Freigabe-Loop (manuell)
```bash
./venv/bin/python cli.py audit  --site whitestag.ai --sites sites.json
# Agent legt Changeset in <report_root>/whitestag.ai/pending/*.json ab
./venv/bin/python cli.py apply  --site whitestag.ai --sites sites.json --root <report_root> --dry-run
./venv/bin/python cli.py approve --changeset <pending/cs.json> --root <report_root>
./venv/bin/python cli.py apply  --site whitestag.ai --sites sites.json --root <report_root>
```
````

- [ ] **Step 3: Commit**

```bash
git add tools/seo-geo/ing.whitestag.seo-geo-audit.plist tools/seo-geo/DEPLOY.md
git commit -m "chore(seo-geo): Deploy-Artefakte (launchd + DEPLOY.md)"
```

---

### Task 12: Manueller Integrations-Smoke-Test (Gate vor Phase 2)

**Files:** keine (Verifikation). **Interfaces:** keine.

- [ ] **Step 1: Volle Test-Suite grün**

Run: `cd tools/seo-geo && python -m pytest -v`
Expected: alle Tests PASS.

- [ ] **Step 2: Deploy nach `~/.paperclip/scripts/seo-geo/`** gemäß DEPLOY.md, `sites.json` mit **einer** echten Test-Domain + Credentials füllen.

- [ ] **Step 3: mu-Plugin auf der Test-Site installieren** (Task 10 README) und curl-Smoke-Test für `/wp-json/whitestag-seo-geo/v1/llms` + `/llms.txt`.

- [ ] **Step 4: Echtes Audit fahren**

Run: `./venv/bin/python cli.py audit --site <testdomain> --sites sites.json`
Expected: `report.json` + `report.md` unter `<report_root>/<testdomain>/` mit plausiblen Findings.

- [ ] **Step 5: Dry-run-Apply** eines handgeschriebenen Ein-Feld-Changesets (`seo_title` einer unwichtigen Testseite), dann `approve` + echtes `apply`, danach im WP-Backend prüfen und **manuell zurücksetzen**. Ergebnis in `docs/superpowers/specs/` notieren (Ist-Stand).

- [ ] **Step 6: Commit (nur falls Fixes nötig waren).**

---

## Phase 2 — Paperclip-Agent + Routine

### Task 13: SEO/GEO-Agent in WHITESTAG anlegen

**Files:**
- Create: `docs/AGENTS-seo-geo.md` (Quell-Persona für den `agents-instructions/`-Generator)

**Interfaces:** Nutzt Paperclip-API (`paperclip`-Skill). Agent-Hire-Flow bei `requireBoardApprovalForNewAgents=true`: `/agent-hires` → `/approve` (siehe `reference_paperclip_agent_create.md`).

- [ ] **Step 1: Persona/AGENTS-Text schreiben** — Rolle „SEO/GEO-Spezialist", Modell `qwen3.6-35b`/Fallback `gemma-4-31b`, Vorgesetzter CTO. Inhalt: Auftrag (Report lesen → priorisieren → deutsche Meta-Texte formulieren → Changeset in `pending/` schreiben), **harte Regel** „niemals redaktionellen Inhalt/Slugs ändern", Feld-Whitelist, Längen-Budgets, Pointer auf `SEO-GEO/Arbeitsanleitung llms.txt fuer Agenten.md` als GEO-Wissensbasis (via `fs_read`), Changeset-JSON-Schema (aus Task 5).

- [ ] **Step 2: Agent anlegen** über `paperclip`-Skill: `/agent-hires` mit Company=WHITESTAG, Rolle, Modell-Config; dann `/approve`. Verifizieren, dass der Agent in der Agentenliste erscheint.

- [ ] **Step 3: AGENTS.md-Generierung anstoßen** (nächtlicher Generator bzw. manuell) und prüfen, dass die generierte AGENTS.md die Whitelist + den Wissens-Pointer enthält.

- [ ] **Step 4: Commit**

```bash
git add docs/AGENTS-seo-geo.md
git commit -m "feat(seo-geo): Persona/AGENTS-Quelle für SEO/GEO-Agent"
```

---

### Task 14: Wöchentliche Audit-Routine + End-to-End-Probe

**Files:** keine (Paperclip-Routine + Verifikation).

**Interfaces:** Paperclip-Routine (`paperclip`-Skill), cron `0 5 * * 1` Europe/Berlin, triggert Audit + weist dem SEO/GEO-Agenten die Vorschlags-Erstellung zu.

- [ ] **Step 1: Routine anlegen** über `paperclip`-Skill (Owner = SEO/GEO-Agent, Aufgabe „Wöchentliches SEO/GEO-Audit für <Site>: Report lesen, Changeset in pending/ erstellen, Vorschlag an Walter"). Cron mit dem launchd-Audit (Task 11) zeitlich abstimmen (launchd crawlt, Routine denkt).

- [ ] **Step 2: End-to-End-Probe** — Routine einmalig manuell auslösen; prüfen, dass der Agent aus `report.json` ein valides `changeset.json` in `pending/` erzeugt (Whitelist eingehalten, deutsche Meta-Texte im Budget) und einen lesbaren Vorschlag an Walter liefert.

- [ ] **Step 3: Freigabe-Durchstich** — Walter gibt einen Vorschlag frei (`approve`), `apply` schreibt live, Verifikation im WP-Backend, Rollback-Log vorhanden.

- [ ] **Step 4: Ist-Stand dokumentieren** in `docs/superpowers/specs/2026-07-11-seo-geo-agent-design.md` (Abschnitt „Umsetzungsstand") und Memory-Eintrag `project_seo_geo_agent.md` anlegen.

---

## Self-Review-Ergebnis

- **Spec-Abdeckung:** Scope §1 → Whitelist (Task 5) + Regeln (Task 3); Autonomie §2 → pending/approved/applied (Task 8); eigener Crawl §3.2 → Tasks 2/4/9; Dienst-Struktur → Tasks 1–11; Sicherheit §6 → Whitelist-Validator + dry-run + Apply-Log; Agent §3.1 → Task 13; Routine §5 → Task 14; llms.txt-GEO → mu-Plugin (Task 10) + `set_llms_txt` (Task 6) + Persona-Pointer (Task 13). Offene Punkte §7: Site-Liste = Config (Task 1/12), Governance = Task 13, Freigabe-Kanal = entschieden (Ordner-Loop), Yoast-REST = mu-Plugin (Task 10).
- **Platzhalter:** keine — jeder Code-Step enthält vollständigen Code.
- **Typkonsistenz:** `EDITABLE_FIELDS`, `_YOAST_MAP`-Keys, Changeset-Schema (`target`/`id`/`field`/`old`/`new`) und `apply_changeset`-Routing sind über Tasks 5–8 identisch benannt.
