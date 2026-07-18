# GEO-Citation-Check (5c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Wochen-Audit-Mail um eine „GEO-Sichtbarkeit"-Sektion erweitern: (A) ob Claude WHITESTAG bei Marken-Fragen nennt, (B) wie oft KI-Crawler die Sites besuchen.

**Architecture:** Zwei reine Python-Module (`geo_citations.py` mit injizierbarem Claude-Runner; `geo_bots.py` als Reader) + mu-Plugin-Erweiterung (Bot-Zählung + REST) + `WPClient`-Methode; `audit_summary.py` hängt eine fail-soft `geo_section` an.

**Tech Stack:** Python 3.11 (venv), `subprocess` (claude-CLI), `requests`/`requests_mock`, `pytest`. Keine neuen pip-Abhängigkeiten.

## Global Constraints

- **Python 3.11+** (venv `tools/seo-geo/venv`). Tests mit `./venv/bin/python -m pytest`.
- **Deploy:** `rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/`.
- **Fail-soft:** 5c darf Onpage+Diff+GSC+Mail nie kippen. Fehlende Config/CLI/Route/Exception → Sektion meldet, Rest läuft.
- **Claude-Zugang:** über die vorhandene `claude`-CLI (`claude -p <prompt> --model <model>`), Walters Anmeldung — KEIN API-Key, keine Zusatzkosten. Runner ist injizierbar; die Produktions-Variante wird NICHT unit-getestet.
- **Kein neuer Alarm-Trigger** — 5c ist informativ; der `<date>-alert.txt`-Mechanismus aus 5b bleibt unberührt.
- **mu-Plugin:** aktueller Header `Version: 0.2.1` → auf **0.2.2** bumpen. Bestehende Muster (`register_rest_route('whitestag-seo-geo/v1', …)`, `update_option`/`get_option`, `add_action`) exakt befolgen. Bot-Wochen rollierend: **max. 8** behalten.
- **KI-Bot-Muster (Teil B):** GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, anthropic-ai, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, CCBot, Bytespider, Amazonbot.
- Commit-Messages enden mit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create `tools/seo-geo/geo_citations.py`** — Teil A: Marken-Prompt-Logik + Runner.
- **Create `tools/seo-geo/geo_bots.py`** — Teil B: Bot-Zahlen-Reader-Logik.
- **Create `tools/seo-geo/geo_prompts.example.json`** — Beispiel-Config (echte liegt im Deploy).
- **Create `tools/seo-geo/test_geo_citations.py`**, **`test_geo_bots.py`**.
- **Modify `tools/seo-geo/wpclient.py`** (+ `test_wpclient.py`) — `get_ai_bot_hits()`.
- **Modify `tools/seo-geo/wp-mu-plugin/whitestag-seo-geo.php`** — Bot-Zählung + REST + v0.2.2.
- **Modify `tools/seo-geo/audit_summary.py`** (+ `test_audit_summary.py`) — `geo_section` + main-Wiring + `<date>-geo.json`.

**Reihenfolge:** 1 → 2 → 3 → 4 → 5.

---

### Task 1: `geo_citations.py` — Marken-Prompt-Logik (Teil A)

**Files:**
- Create: `tools/seo-geo/geo_citations.py`, `tools/seo-geo/test_geo_citations.py`
- Create: `tools/seo-geo/geo_prompts.example.json`

**Interfaces:**
- Produces:
  - `check_mention(answer, brand_terms) -> bool` (case-insensitive Substring).
  - `evaluate(config, runner) -> list[dict]` — je Prompt `{"prompt","mentioned"}` bzw. `{"prompt","error"}`; `runner(prompt, model) -> str`.
  - `claude_runner(prompt, model, timeout=120) -> str` (Produktion; Subprozess; nicht unit-getestet).

- [ ] **Step 1: Beispiel-Config anlegen** — `geo_prompts.example.json`:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "brand_terms": ["whitestag", "whitestag.ai", "whitestag.film"],
  "prompts": [
    "Wer produziert 360°-3D-Virtual-Reality-Filme in der Lausitz bzw. in Cottbus?",
    "Welche Anbieter helfen Unternehmen in Brandenburg beim Einstieg in KI?",
    "Nenne Dienstleister für immersive VR-Filmproduktion in Ostdeutschland."
  ]
}
```

- [ ] **Step 2: Failing tests schreiben** — `test_geo_citations.py`:

```python
from geo_citations import check_mention, evaluate

def test_check_mention_case_insensitive():
    assert check_mention("Die Firma WHITESTAG aus Cottbus …", ["whitestag"]) is True
    assert check_mention("Andere Anbieter …", ["whitestag"]) is False
    assert check_mention("siehe whitestag.film", ["whitestag.ai", "whitestag.film"]) is True

def test_evaluate_genannt_und_nicht():
    cfg = {"model": "m", "brand_terms": ["whitestag"],
           "prompts": ["frage1", "frage2"]}
    answers = {"frage1": "Ja, WHITESTAG.", "frage2": "Keine Ahnung."}
    res = evaluate(cfg, runner=lambda p, m: answers[p])
    assert res[0] == {"prompt": "frage1", "mentioned": True}
    assert res[1] == {"prompt": "frage2", "mentioned": False}

def test_evaluate_runner_fehler_wird_error():
    cfg = {"model": "m", "brand_terms": ["whitestag"], "prompts": ["frage1"]}
    def boom(p, m): raise RuntimeError("cli weg")
    res = evaluate(cfg, runner=boom)
    assert res[0]["prompt"] == "frage1"
    assert "cli weg" in res[0]["error"]
    assert "mentioned" not in res[0]
```

- [ ] **Step 3: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_geo_citations.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'geo_citations'`).

- [ ] **Step 4: `geo_citations.py` implementieren**

```python
"""Teil A des GEO-Citation-Checks: Marken-Prompts an Claude, Nennungs-Prüfung.
Der Claude-Zugang läuft über die claude-CLI (Walters Anmeldung), injizierbar für Tests."""
import subprocess


def check_mention(answer, brand_terms):
    low = (answer or "").lower()
    return any(t.lower() in low for t in brand_terms)


def evaluate(config, runner):
    brand = config.get("brand_terms", [])
    model = config.get("model", "claude-haiku-4-5-20251001")
    out = []
    for prompt in config.get("prompts", []):
        try:
            answer = runner(prompt, model)
        except Exception as e:  # noqa: BLE001
            out.append({"prompt": prompt, "error": str(e)})
            continue
        out.append({"prompt": prompt, "mentioned": check_mention(answer, brand)})
    return out


def claude_runner(prompt, model, timeout=120):
    """Produktion: einmaliger claude-CLI-Aufruf. Nicht unit-getestet."""
    r = subprocess.run(["claude", "-p", prompt, "--model", model],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"claude exit {r.returncode}: {r.stderr.strip()[:200]}")
    return r.stdout
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_geo_citations.py -v`
Expected: PASS (3 Tests).

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/geo_citations.py tools/seo-geo/test_geo_citations.py tools/seo-geo/geo_prompts.example.json
git commit -m "feat(seo-geo): GEO Teil A — Marken-Prompt-Nennungsprüfung (Claude-CLI-Runner)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `geo_bots.py` + `WPClient.get_ai_bot_hits` (Teil B Reader)

**Files:**
- Create: `tools/seo-geo/geo_bots.py`, `tools/seo-geo/test_geo_bots.py`
- Modify: `tools/seo-geo/wpclient.py`, `tools/seo-geo/test_wpclient.py`

**Interfaces:**
- Produces:
  - `WPClient.get_ai_bot_hits() -> dict` (GET `/whitestag-seo-geo/v1/aibots`).
  - `geo_bots.current_week_hits(data, iso_week) -> dict` (Bot→Count für die Woche; `{}` wenn fehlt).
  - `geo_bots.iso_week(date) -> str` (`"<isojahr>-W<kw2stellig>"`).

- [ ] **Step 1: Failing tests schreiben** — `test_geo_bots.py`:

```python
import datetime
from geo_bots import current_week_hits, iso_week

def test_iso_week_format():
    assert iso_week(datetime.date(2026, 7, 18)) == "2026-W29"

def test_current_week_hits_vorhanden():
    data = {"2026-W29": {"GPTBot": 12, "ClaudeBot": 3}, "2026-W28": {"GPTBot": 5}}
    assert current_week_hits(data, "2026-W29") == {"GPTBot": 12, "ClaudeBot": 3}

def test_current_week_hits_fehlt_leer():
    assert current_week_hits({"2026-W28": {"GPTBot": 5}}, "2026-W29") == {}
```

und in `test_wpclient.py` ergänzen:

```python
def test_get_ai_bot_hits():
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/whitestag-seo-geo/v1/aibots",
              json={"2026-W29": {"GPTBot": 4}})
        assert _client().get_ai_bot_hits() == {"2026-W29": {"GPTBot": 4}}
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_geo_bots.py test_wpclient.py -k "iso_week or current_week or ai_bot" -v`
Expected: FAIL (`ModuleNotFoundError` / `AttributeError get_ai_bot_hits`).

- [ ] **Step 3: Implementieren** — `geo_bots.py`:

```python
"""Teil B des GEO-Citation-Checks: KI-Bot-Zugriffszahlen (vom mu-Plugin) auswerten."""


def iso_week(date):
    y, w, _ = date.isocalendar()
    return f"{y}-W{w:02d}"


def current_week_hits(data, iso_week_str):
    v = (data or {}).get(iso_week_str)
    return v if isinstance(v, dict) else {}
```

`wpclient.py` — Methode ergänzen (nutzt vorhandenes `self.http`/`self.auth`):

```python
    def get_ai_bot_hits(self):
        r = self.http.get(f"{self.base}/whitestag-seo-geo/v1/aibots",
                          auth=self.auth, timeout=30)
        r.raise_for_status()
        return r.json()
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_geo_bots.py test_wpclient.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/geo_bots.py tools/seo-geo/test_geo_bots.py tools/seo-geo/wpclient.py tools/seo-geo/test_wpclient.py
git commit -m "feat(seo-geo): GEO Teil B Reader — get_ai_bot_hits + Wochen-Extraktion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: mu-Plugin v0.2.2 — KI-Bot-Zählung + REST

**Files:**
- Modify: `tools/seo-geo/wp-mu-plugin/whitestag-seo-geo.php`

**Interfaces:**
- Produces: Option `whitestag_ai_bot_hits` = `{ "<ISO-Woche>": { "<bot>": int } }` (max 8 Wochen); REST `GET /whitestag-seo-geo/v1/aibots`.

- [ ] **Step 1: Version bumpen** — Header `Version: 0.2.1` → `Version: 0.2.2`.

- [ ] **Step 2: Bot-Zählung auf `init`** — ergänzen (Muster wie bestehende `add_action('init', …)`):

```php
add_action('init', function () {
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    if ($ua === '') return;
    $bots = ['GPTBot','ChatGPT-User','OAI-SearchBot','ClaudeBot','anthropic-ai',
             'Claude-User','PerplexityBot','Perplexity-User','Google-Extended',
             'CCBot','Bytespider','Amazonbot'];
    $hit = null;
    foreach ($bots as $b) { if (stripos($ua, $b) !== false) { $hit = $b; break; } }
    if ($hit === null) return;
    $week = gmdate('o-\WW');                       // ISO-Jahr + KW, z.B. 2026-W29
    $data = get_option('whitestag_ai_bot_hits', []);
    if (!is_array($data)) $data = [];
    if (!isset($data[$week])) $data[$week] = [];
    $data[$week][$hit] = ($data[$week][$hit] ?? 0) + 1;
    if (count($data) > 8) {                        // rollierend: 8 Wochen
        ksort($data);
        $data = array_slice($data, -8, null, true);
    }
    update_option('whitestag_ai_bot_hits', $data, false);
});
```

- [ ] **Step 3: REST-Leseroute** — ergänzen (Muster wie die bestehende `llms`-GET-Route; Redakteur-Capability wie dort):

```php
add_action('rest_api_init', function () {
    register_rest_route('whitestag-seo-geo/v1', '/aibots', [
        'methods' => 'GET',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
        'callback' => function () {
            $d = get_option('whitestag_ai_bot_hits', []);
            return is_array($d) ? $d : [];
        },
    ]);
});
```

> Hinweis: `edit_posts` deckt den `seo-geo-bot`-Redakteur ab (wie die anderen Lese-Routen). Prüfen, dass die tatsächlich im Plugin verwendete Lese-Capability übernommen wird — falls die bestehenden GET-Routen eine andere nutzen, dieselbe verwenden.

- [ ] **Step 4: Syntaxprüfung (falls php-CLI vorhanden, sonst visuell)**

Run: `php -l tools/seo-geo/wp-mu-plugin/whitestag-seo-geo.php 2>/dev/null || echo "php-CLI nicht vorhanden — visuell geprüft"`
Expected: `No syntax errors detected` oder der Hinweis.

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/wp-mu-plugin/whitestag-seo-geo.php
git commit -m "feat(seo-geo): mu-Plugin v0.2.2 — KI-Bot-Zaehlung (Wochen-Rolling) + /aibots-REST

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `geo_section` in `audit_summary.py` + main-Wiring

**Files:**
- Modify: `tools/seo-geo/audit_summary.py`, `tools/seo-geo/test_audit_summary.py`

**Interfaces:**
- Consumes: `geo_citations.evaluate/claude_runner`, `geo_bots.iso_week/current_week_hits`, `config.load_sites`, `config.resolve_credential`, `wpclient.WPClient`.
- Produces: `geo_section(sites_path, environ, today) -> tuple[str, list]` (markdown, geo_data); main hängt Sektion an + schreibt `<date>-geo.json`.

- [ ] **Step 1: Failing test schreiben** — `test_audit_summary.py`:

```python
import datetime
from audit_summary import geo_section

def test_geo_section_ohne_prompts_und_ohne_route_ist_failsoft(tmp_path, monkeypatch):
    # sites.json ohne echte WP-Route; keine geo_prompts.json im cwd
    sites = tmp_path / "sites.json"
    sites.write_text('{"report_root":"%s","sites":[]}' % tmp_path)
    monkeypatch.chdir(tmp_path)
    md, data = geo_section(str(sites), {}, datetime.date(2026, 7, 18))
    assert "GEO-Sichtbarkeit" in md
    assert isinstance(data, list)
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -k geo_section -v`
Expected: FAIL (`ImportError: cannot import name 'geo_section'`).

- [ ] **Step 3: `geo_section` implementieren + in `main()` verdrahten** — in `audit_summary.py`:

```python
def geo_section(sites_path, environ, today):
    """Fail-soft GEO-Sichtbarkeit: Teil A (Claude-Marken-Prompts) + Teil B (KI-Bot-Zugriffe)."""
    import json as _json
    lines = ["", "## GEO-Sichtbarkeit", ""]
    geo_data = {"prompts": [], "bots": {}}
    # Teil A — Marken-Prompts
    prompts_path = os.path.join(os.path.dirname(os.path.abspath(sites_path)), "geo_prompts.json")
    try:
        if os.path.exists(prompts_path):
            import geo_citations
            cfg = _json.loads(open(prompts_path).read())
            res = geo_citations.evaluate(cfg, geo_citations.claude_runner)
            geo_data["prompts"] = res
            lines.append("**KI-Marken-Prompts (Claude):**")
            for r in res:
                if "error" in r:
                    lines.append(f"  - ⚠️ „{r['prompt']}\" — Fehler: {r['error']}")
                else:
                    lines.append(f"  - {'✅ genannt' if r['mentioned'] else '❌ nicht genannt'}: „{r['prompt']}\"")
        else:
            lines.append("**KI-Marken-Prompts:** keine `geo_prompts.json` konfiguriert.")
    except Exception as e:  # noqa: BLE001
        lines.append(f"**KI-Marken-Prompts:** Fehler ({e}).")
    # Teil B — KI-Bot-Zugriffe je Site
    try:
        import geo_bots
        from config import load_sites, resolve_credential
        from wpclient import WPClient
        wk = geo_bots.iso_week(today)
        lines.append("")
        lines.append(f"**KI-Bot-Zugriffe (Woche {wk}):**")
        for site in load_sites(sites_path):
            try:
                client = WPClient(site.wp_rest_base, resolve_credential(site, environ))
                hits = geo_bots.current_week_hits(client.get_ai_bot_hits(), wk)
                geo_data["bots"][site.name] = hits
                if hits:
                    lines.append(f"  - {site.name}: " + ", ".join(f"{b}: {c}" for b, c in sorted(hits.items())))
                else:
                    lines.append(f"  - {site.name}: keine KI-Bot-Zugriffe erfasst")
            except Exception as e:  # noqa: BLE001
                lines.append(f"  - {site.name}: keine Bot-Daten ({e})")
    except Exception as e:  # noqa: BLE001
        lines.append(f"**KI-Bot-Zugriffe:** Fehler ({e}).")
    lines.append("")
    lines.append("_Teil A misst Marken-Präsenz in Claudes Wissen (kein Live-Web), "
                 "nicht eine Live-Quellen-Zitierung._")
    return "\n".join(lines), geo_data
```

In `main()`, NACH dem GSC-Block (nach `body = body + diff_md + gsc_md`) einfügen:

```python
    geo_md, geo_data = geo_section(args.sites, os.environ, today_date)
    body = body + geo_md
    with open(os.path.join(hist_dir, f"{today}-geo.json"), "w") as fh:
        json.dump(geo_data, fh, ensure_ascii=False, indent=2)
```

(`today_date` = `datetime.date`, `today` = String — beide existieren bereits in `main()`.)

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_audit_summary.py -v`
Expected: PASS.

- [ ] **Step 5: Gesamt-Suite**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest -q`
Expected: PASS (alle).

- [ ] **Step 6: Commit**

```bash
git add tools/seo-geo/audit_summary.py tools/seo-geo/test_audit_summary.py
git commit -m "feat(seo-geo): GEO-Sichtbarkeits-Sektion (Prompts + Bots) in die Wochen-Mail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Deploy + End-to-End-Verifikation

**Files:** keine (Deploy, Config, Verifikation).

- [ ] **Step 1: geo_prompts.json im Deploy anlegen**

```bash
cp tools/seo-geo/geo_prompts.example.json ~/.paperclip/scripts/seo-geo/geo_prompts.json
```

- [ ] **Step 2: Deploy**

```bash
cd "$(git rev-parse --show-toplevel)"
rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache tools/seo-geo/ ~/.paperclip/scripts/seo-geo/
```
Expected: rsync ok (die zuvor kopierte `geo_prompts.json` bleibt — kein `--delete`).

- [ ] **Step 3: Teil A live testen (Claude-CLI, echt)**

```bash
cd ~/.paperclip/scripts/seo-geo
./venv/bin/python - <<'PY'
import json, geo_citations
cfg = json.loads(open("geo_prompts.json").read())
cfg["prompts"] = cfg["prompts"][:1]   # nur 1 Prompt für den Rauchtest
print(geo_citations.evaluate(cfg, geo_citations.claude_runner))
PY
```
Expected: `[{'prompt': '…', 'mentioned': True|False}]` (kein Fehler → CLI erreichbar).

- [ ] **Step 4: geo_section fail-soft (Bots ohne Plugin-Route)**

```bash
cd ~/.paperclip/scripts/seo-geo
set -a; source ~/.whitestag.env 2>/dev/null; set +a
./venv/bin/python - <<'PY'
import datetime, os, audit_summary
md, data = audit_summary.geo_section("sites.json", os.environ, datetime.date.today())
print(md)
PY
```
Expected: „GEO-Sichtbarkeit"-Sektion; Teil A mit Prompt-Ergebnissen; Teil B je Site „keine KI-Bot-Zugriffe erfasst" bzw. „keine Bot-Daten" (Plugin-Route erst nach mu-Plugin-Deploy auf die Sites live — das macht Walter/der SFTP-losen mu-Plugin-Weg separat).

- [ ] **Step 5: Suite + ganze Routine**

```bash
cd ~/.paperclip/scripts/seo-geo && ./venv/bin/python -m pytest -q
launchctl kickstart -k gui/$(id -u)/ing.whitestag.seo-geo-audit && sleep 120 && tail -40 /tmp/seo-geo-audit.log
```
Expected: Suite grün; Mail enthält die „GEO-Sichtbarkeit"-Sektion.

---

## Self-Review

**Spec-Coverage:**
- Teil A Marken-Prompts (Claude-CLI, Nennungsprüfung) → Task 1 ✓
- Teil B Reader (Bot-Zahlen, Wochen) → Task 2 ✓
- mu-Plugin Bot-Zählung + REST (v0.2.2, 8 Wochen) → Task 3 ✓
- GEO-Sichtbarkeits-Mailsektion + `<date>-geo.json` → Task 4 ✓
- Einordnungs-Fußnote (Wissen ≠ Live-Zitat) → Task 4 (Sektionstext) ✓
- Fail-soft (keine Config/CLI/Route/Exception) → Task 1 (evaluate try), Task 4 (geo_section try je Teil) ✓
- Kein neuer Alarm-Trigger → geo_section liefert nur (markdown, data), berührt `<date>-alert.txt` nicht ✓
- Tests wie `test_*.py` → Tasks 1,2,4 ✓

**Platzhalter:** keine; jeder Code-Step zeigt vollständigen Code.

**Typ-Konsistenz:** `evaluate` liefert Liste von `{prompt, mentioned}` / `{prompt, error}` — in `geo_section` genau so gelesen. `current_week_hits` liefert `dict[bot,count]` — in `geo_section` iteriert. `iso_week(date)` erwartet ein `datetime.date` (in `main()` `today_date`). `WPClient.get_ai_bot_hits` GET-Pfad == mu-Plugin-Route `/whitestag-seo-geo/v1/aibots`. mu-Plugin-Optionsname `whitestag_ai_bot_hits` in Schreib- und Leseroute identisch.

**Offen (nicht blockierend):** mu-Plugin muss auf die 4 Sites ausgerollt werden, damit Teil B echte Zahlen liefert (bis dahin fail-soft „keine Bot-Daten"); Modell/Prompts in `geo_prompts.json` justierbar.
