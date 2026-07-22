# Jarvis Mandantenfähiger Vault-Lookup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Jarvis-Vault-Lookup mandantenfähig machen, sodass Claras Büroleiter Claras Vault durchsucht statt WHITESTAGs — und damit ein Cross-Tenant-Datenleck schließen.

**Architecture:** Eine `VAULTS`-Registry ersetzt die hartkodierten Vault-Konstanten in `vault_lookup.py`. Ein `vault`-Selektor (`"whitestag"` | `"clara"`) wird durch die Kette Bot → HTTP-Client → Server → Lookup-Logik gereicht. Fehlt er, gilt der Default `"whitestag"` — dadurch bleibt Luna/n8n (nutzt denselben `:7788`-Dienst, bedient nur WHITESTAG) unverändert.

**Tech Stack:** Python 3 stdlib-only (urllib, http.server, glob, subprocess/ripgrep), Tests mit `unittest` via pytest 8.4.2, Deployment via launchd User-LaunchAgents.

## Global Constraints

- **stdlib-only:** Keine Fremd-Pakete in `vault_lookup.py`, `server.py`, `vault_client.py` — muss in n8n-Code-Nodes und im Python-Bot laufen.
- **Rückwärtskompatibilität:** Ein Aufruf ohne `vault` (Body-Feld bzw. Argument) MUSS exakt das heutige WHITESTAG-Verhalten liefern. Luna/n8n wird nicht angefasst.
- **Token-Defaults inline, env-überschreibbar:** WHITESTAG `BRAIN_TOKEN` = `5bc3675e4fc5e83977107dce675e2fde2038fda0b70b818f24aa99dbf90fe764`; Clara `BRAIN_TOKEN_CLARA` = `ad3cae15e8264696f5943ded6cf9edba2ff9de14a12a9b49a1f3ea5a0019d03e`.
- **Vault-Pfade:** WHITESTAG = `~/Obsidian/WHITESTAG-Vault`; Clara = `/Volumes/homes/cw/Obsidian/Clara-Vault`.
- **Brain-URLs:** WHITESTAG = `http://localhost:7777/`; Clara = `http://localhost:7778/`.
- **Tests im `unittest.TestCase`-Stil** (wie alle bestehenden `test_*.py`), lauffähig via `pytest <datei> -v`.
- **Quelle vs. Deploy:** Bearbeitet wird die Quelle unter `tools/`. Das Laufende sind die deployten Kopien unter `~/.paperclip/scripts/…` + `~/.paperclip/voice-echo-tenants.json`. Deployment ist Task 6.

---

### Task 1: `VAULTS`-Registry + `resolve_vault` in `vault_lookup.py`

Führt die Registry und den Resolver ein, ohne die Lookup-Funktionen anzufassen. Erster testbarer Baustein.

**Files:**
- Modify: `tools/vault-lookup/vault_lookup.py` (Konstanten-Block, Zeilen 18–28)
- Test: `tools/vault-lookup/test_vault_lookup.py` (Create)

**Interfaces:**
- Produces: `VAULTS: dict[str, dict]` mit Keys `"whitestag"`, `"clara"`; jede Value hat `{"path": str, "brain_url": str, "brain_token": str}`. `DEFAULT_VAULT = "whitestag"`. `resolve_vault(vault: str | None) -> dict` — gibt bei unbekanntem/`None`-Wert die Default-Config zurück.

- [ ] **Step 1: Write the failing test**

Create `tools/vault-lookup/test_vault_lookup.py`:

```python
# tools/vault-lookup/test_vault_lookup.py
import os
import unittest

import vault_lookup


class TestResolveVault(unittest.TestCase):
    def test_clara_resolves_to_clara_path(self):
        cfg = vault_lookup.resolve_vault("clara")
        self.assertEqual(cfg["path"], "/Volumes/homes/cw/Obsidian/Clara-Vault")
        self.assertIn("7778", cfg["brain_url"])

    def test_whitestag_resolves_to_whitestag_path(self):
        cfg = vault_lookup.resolve_vault("whitestag")
        self.assertEqual(cfg["path"], os.path.expanduser("~/Obsidian/WHITESTAG-Vault"))
        self.assertIn("7777", cfg["brain_url"])

    def test_none_falls_back_to_default(self):
        self.assertEqual(vault_lookup.resolve_vault(None),
                         vault_lookup.VAULTS[vault_lookup.DEFAULT_VAULT])

    def test_unknown_falls_back_to_default(self):
        self.assertEqual(vault_lookup.resolve_vault("gibtsnicht"),
                         vault_lookup.VAULTS[vault_lookup.DEFAULT_VAULT])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/vault-lookup && pytest test_vault_lookup.py -v`
Expected: FAIL mit `AttributeError: module 'vault_lookup' has no attribute 'resolve_vault'`

- [ ] **Step 3: Write minimal implementation**

In `tools/vault-lookup/vault_lookup.py` den Konstanten-Block (aktuell Zeilen 18–28) ersetzen:

```python
def _token(env_name, default):
    return os.environ.get(env_name, default)


VAULTS = {
    "whitestag": {
        "path": os.path.expanduser("~/Obsidian/WHITESTAG-Vault"),
        "brain_url": "http://localhost:7777/",
        "brain_token": _token(
            "BRAIN_TOKEN",
            "5bc3675e4fc5e83977107dce675e2fde2038fda0b70b818f24aa99dbf90fe764"),
    },
    "clara": {
        "path": "/Volumes/homes/cw/Obsidian/Clara-Vault",
        "brain_url": "http://localhost:7778/",
        "brain_token": _token(
            "BRAIN_TOKEN_CLARA",
            "ad3cae15e8264696f5943ded6cf9edba2ff9de14a12a9b49a1f3ea5a0019d03e"),
    },
}
DEFAULT_VAULT = "whitestag"


def resolve_vault(vault):
    """Liefert die Vault-Config; unbekannter/None-Wert -> Default (WHITESTAG)."""
    return VAULTS.get(vault or DEFAULT_VAULT, VAULTS[DEFAULT_VAULT])
```

Hinweis: Die alten Modul-Globals `VAULT`, `KONTAKTE`, `TERMINE`, `EMAILS`, `BRAIN_URL`, `BRAIN_TOKEN` werden in Task 2 aus den Funktionen entfernt. In diesem Task bleiben sie noch nicht referenziert durch die Registry — die Lookup-Funktionen nutzen weiter die Globals, deshalb müssen `VAULT`/`KONTAKTE`/`TERMINE`/`EMAILS`/`BRAIN_URL`/`BRAIN_TOKEN` in diesem Zwischenschritt bestehen bleiben. Konkret: Registry-Block **zusätzlich** einfügen, die alten Konstanten (Zeilen 18–28) vorerst **stehen lassen**. Task 2 räumt sie weg.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/vault-lookup && pytest test_vault_lookup.py -v`
Expected: PASS (4 Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/vault-lookup/vault_lookup.py tools/vault-lookup/test_vault_lookup.py
git commit -m "feat(vault-lookup): VAULTS-Registry + resolve_vault (whitestag|clara)"
```

---

### Task 2: Lookup-Funktionen auf `cfg` umstellen + `lookup(mode, query, vault)`

Parametrisiert alle fünf Lookup-Funktionen mit der Vault-Config und reicht den `vault`-Selektor durch den Dispatcher. Entfernt die alten Globals.

**Files:**
- Modify: `tools/vault-lookup/vault_lookup.py` (Funktionen `lookup_kontakt`, `lookup_termine`, `lookup_mail`, `search_wissen`, `lookup_dokument`, `lookup`, `__main__`)
- Test: `tools/vault-lookup/test_vault_lookup.py` (Modify — Routing-Test ergänzen)

**Interfaces:**
- Consumes: `resolve_vault`, `VAULTS`, `DEFAULT_VAULT` aus Task 1.
- Produces: `lookup(mode: str, query: str, vault: str | None = DEFAULT_VAULT) -> dict`. Jede Funktion `lookup_kontakt/lookup_termine/lookup_mail/search_wissen/lookup_dokument(query, cfg, limit=...)` nimmt als zweites Argument die aufgelöste `cfg`.

- [ ] **Step 1: Write the failing test**

In `tools/vault-lookup/test_vault_lookup.py` ergänzen (Import `tempfile` oben hinzufügen):

```python
import tempfile


class TestLookupRouting(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.clara = tempfile.mkdtemp()
        for base, who in ((self.ws, "WHITESTAG"), (self.clara, "CLARA")):
            k = os.path.join(base, "Kontakte")
            os.makedirs(k)
            with open(os.path.join(k, "jana.md"), "w", encoding="utf-8") as fh:
                fh.write("# Jana Kostbar\nHaus: {}\nTel: 123\n".format(who))
        self._orig = vault_lookup.VAULTS
        vault_lookup.VAULTS = {
            "whitestag": {"path": self.ws, "brain_url": "http://localhost:7777/", "brain_token": "x"},
            "clara": {"path": self.clara, "brain_url": "http://localhost:7778/", "brain_token": "y"},
        }

    def tearDown(self):
        vault_lookup.VAULTS = self._orig

    def test_clara_reads_clara_vault(self):
        out = vault_lookup.lookup("kontakt", "Jana", vault="clara")
        self.assertTrue(any("CLARA" in t["inhalt"] for t in out["treffer"]))
        self.assertFalse(any("WHITESTAG" in t["inhalt"] for t in out["treffer"]))

    def test_default_reads_whitestag_vault(self):
        out = vault_lookup.lookup("kontakt", "Jana")
        self.assertTrue(any("WHITESTAG" in t["inhalt"] for t in out["treffer"]))
        self.assertFalse(any("CLARA" in t["inhalt"] for t in out["treffer"]))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/vault-lookup && pytest test_vault_lookup.py::TestLookupRouting -v`
Expected: FAIL — `lookup()` nimmt noch kein `vault`-Argument bzw. liest weiter aus dem festen `VAULT` (`TypeError` oder falscher/leerer Treffer).

- [ ] **Step 3: Write minimal implementation**

In `tools/vault-lookup/vault_lookup.py`:

**(a)** Die alten Globals `VAULT`, `KONTAKTE`, `TERMINE`, `EMAILS` (Zeilen 18–21) sowie `BRAIN_URL`, `BRAIN_TOKEN` (Zeilen 23–28) **löschen** (die Registry aus Task 1 ersetzt sie).

**(b)** `lookup_kontakt` ersetzen:

```python
def lookup_kontakt(query, cfg, limit=3):
    """Findet Kontaktkarten per Namens-/Domain-Match. Gibt vollen Kartentext
    zurück, damit das LLM die konkret gefragte Angabe (Tel/Mail/…) rauszieht."""
    base = cfg["path"]
    kontakte = os.path.join(base, "Kontakte")
    if not os.path.isdir(kontakte):
        return []
    qtoks = [t for t in _tokens(query) if t not in ("kontakt", "nummer", "telefon",
             "telefonnummer", "mail", "email", "adresse", "von", "der", "die", "das")]
    scored = []
    for path in glob.glob(os.path.join(kontakte, "*.md")):
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        hay = (os.path.basename(path) + "\n" + text[:600]).lower()
        score = sum(1 for t in qtoks if t in hay)
        if score:
            scored.append((score, path, text))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, path, text in scored[:limit]:
        out.append({"quelle": os.path.relpath(path, base), "score": score,
                    "inhalt": text.strip()[:1500]})
    return out
```

**(c)** `lookup_termine` ersetzen:

```python
def lookup_termine(query, cfg, limit=15):
    base = cfg["path"]
    termine = os.path.join(base, "Termine")
    if not os.path.isdir(termine):
        return []
    start, end = _parse_datumsfenster(query)
    out = []
    for path in sorted(glob.glob(os.path.join(termine, "*.md"))):
        m = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path))
        if not m:
            continue
        try:
            d = datetime.strptime(m.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        if start <= d <= end:
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            out.append({"datum": m.group(1), "quelle": os.path.relpath(path, base),
                        "inhalt": text.strip()[:600]})
    return out[:limit]
```

**(d)** `lookup_mail` ersetzen:

```python
def lookup_mail(query, cfg, limit=5):
    base = cfg["path"]
    emails = os.path.join(base, "E-Mails")
    if not os.path.isdir(emails):
        return []
    qtoks = [t for t in _tokens(query) if t not in ("mail", "email", "von", "letzte", "der")]
    scored = []
    for path in glob.glob(os.path.join(emails, "*.md")):
        base_name = os.path.basename(path)
        try:
            head = open(path, encoding="utf-8").read(700)
        except OSError:
            continue
        hay = (base_name + "\n" + head).lower()
        score = sum(1 for t in qtoks if t in hay)
        if score:
            scored.append((score, base_name[:10], path, head))
    scored.sort(key=lambda x: (-x[0], x[1]), reverse=False)
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)  # score desc, dann Datum desc
    out = []
    for score, _d, path, head in scored[:limit]:
        out.append({"quelle": os.path.relpath(path, base), "score": score,
                    "auszug": head.strip()[:500]})
    return out
```

**(e)** `search_wissen` ersetzen:

```python
def search_wissen(query, cfg, limit=5):
    """Semantische Brain-Suche für thematische/Wissensfragen."""
    body = json.dumps({"tool": "search_vault",
                       "args": {"query": query, "limit": limit}}).encode()
    req = urllib.request.Request(cfg["brain_url"], data=body, method="POST",
        headers={"Authorization": "Bearer " + cfg["brain_token"],
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return [{"fehler": f"Brain nicht erreichbar: {e}"}]
    res = data.get("result", [])
    return [{"quelle": h.get("path"), "score": round(h.get("score", 0), 3),
             "auszug": (h.get("snippet") or h.get("text") or "")[:400]}
            for h in (res if isinstance(res, list) else [])]
```

**(f)** `lookup_dokument` ersetzen (Signatur + `base` statt `VAULT`):

```python
def lookup_dokument(query, cfg, limit=6):
    """Volltextsuche (ripgrep) ueber den GANZEN Vault — findet exakte Begriffe
    in jedem Dokument, unabhaengig vom Brain-Index."""
    import subprocess
    from collections import Counter
    base = cfg["path"]
    toks = [t for t in _tokens(query) if len(t) > 2 and t.lower() not in _DOC_STOP]
    if not toks:
        return []
    score = Counter()
    for tok in toks[:6]:
        try:
            r = subprocess.run([_RG, "-li", "--no-messages", "-g", "*.md", tok, base],
                               capture_output=True, text=True, timeout=20)
        except Exception:
            continue
        for path in r.stdout.strip().splitlines():
            score[path] += 1
    ranked = []
    for path, s in score.items():
        base_name = os.path.basename(path).lower()
        bonus = sum(1 for t in toks if t.lower() in base_name)
        ranked.append((s + bonus, s, path))
    ranked.sort(reverse=True)
    out = []
    pat = "|".join(re.escape(t) for t in toks)
    for _rank, s, path in ranked[:limit]:
        snippet = ""
        try:
            r = subprocess.run([_RG, "-i", "--no-messages", "-m", "3", pat, path],
                               capture_output=True, text=True, timeout=10)
            snippet = r.stdout.strip()[:400]
        except Exception:
            pass
        out.append({"quelle": os.path.relpath(path, base),
                    "treffer_begriffe": s, "auszug": snippet})
    return out
```

**(g)** Dispatcher `lookup` ersetzen:

```python
def lookup(mode, query, vault=DEFAULT_VAULT):
    cfg = resolve_vault(vault)
    fn = {"kontakt": lookup_kontakt, "termin": lookup_termine,
          "mail": lookup_mail, "wissen": search_wissen,
          "dokument": lookup_dokument}.get(mode)
    if not fn:
        return {"mode": mode, "fehler": "unbekannter Modus (kontakt|termin|mail|wissen|dokument)"}
    return {"mode": mode, "query": query, "treffer": fn(query, cfg)}
```

**(h)** `__main__`-Block ersetzen (optionaler dritter CLI-Arg `vault`, damit manuelles Testen beide Vaults erreicht):

```python
if __name__ == "__main__":
    import sys
    m = sys.argv[1] if len(sys.argv) > 1 else "kontakt"
    v = os.environ.get("VAULT_SEL", DEFAULT_VAULT)
    q = " ".join(sys.argv[2:]) or "Jana Kostbar"
    print(json.dumps(lookup(m, q, v), ensure_ascii=False, indent=1))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/vault-lookup && pytest test_vault_lookup.py -v`
Expected: PASS (alle Tests aus Task 1 + `TestLookupRouting`)

- [ ] **Step 5: Commit**

```bash
git add tools/vault-lookup/vault_lookup.py tools/vault-lookup/test_vault_lookup.py
git commit -m "feat(vault-lookup): Lookup-Funktionen mandantenfähig (cfg-Threading, vault-Selektor)"
```

---

### Task 3: `server.py` reicht `vault` durch

**Files:**
- Modify: `tools/vault-lookup/server.py` (Create — Quelle fehlt bisher unter `tools/`, existiert nur deployt) bzw. bring die Quelle auf Stand.
- Test: manueller Smoke-Test (kein Unit-Test; `server.py` bindet einen Port — Verifikation in Task 6 live).

**Interfaces:**
- Consumes: `vault_lookup.lookup(mode, query, vault)` aus Task 2.

> Hinweis: Unter `tools/vault-lookup/` liegt aktuell **kein** `server.py` (nur die deployte Kopie in `~/.paperclip/scripts/vault-lookup/server.py`). Dieser Task legt die Quelle an, damit Quelle und Deploy künftig übereinstimmen.

- [ ] **Step 1: Quelle anlegen/aktualisieren**

Create `tools/vault-lookup/server.py`:

```python
#!/usr/bin/env python3
"""Kleiner lokaler HTTP-Dienst um vault_lookup — für Luna (n8n) + Jarvis (Python).
POST /lookup  {"mode":"kontakt|termin|mail|wissen|dokument","query":"...","vault":"whitestag|clara"}  → JSON.
`vault` ist optional; fehlt es, gilt der Default (whitestag).
Nur 127.0.0.1, nur lesend, keine Auth (lokal gebunden)."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import vault_lookup

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            out = vault_lookup.lookup(body.get("mode", "kontakt"),
                                      body.get("query", ""),
                                      body.get("vault"))
            code = 200
        except Exception as e:  # noqa: BLE001
            out = {"fehler": str(e)}; code = 400
        data = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"vault-lookup ok")
    def log_message(self, *a): pass

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 7788), H).serve_forever()
```

- [ ] **Step 2: Syntax-/Import-Check (ohne Port-Bindung)**

Run: `cd tools/vault-lookup && python3 -c "import ast; ast.parse(open('server.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add tools/vault-lookup/server.py
git commit -m "feat(vault-lookup): server reicht optionalen vault-Selektor durch"
```

---

### Task 4: `vault_client.py` akzeptiert `vault` + `dokument` in `VALID_MODES`

**Files:**
- Modify: `tools/voice-echo-bot/vault_client.py` (Zeilen 15, 22–26)
- Test: `tools/voice-echo-bot/test_vault_client.py` (Modify)

**Interfaces:**
- Produces: `vault_client.lookup(mode, query, vault=None, url=VAULT_LOOKUP_URL, timeout=30) -> dict`. `vault` wandert nur in den Request-Body, wenn wahrheitswert-positiv.

- [ ] **Step 1: Write the failing test**

In `tools/voice-echo-bot/test_vault_client.py` in `class TestLookup` ergänzen:

```python
    def test_vault_added_to_body_when_set(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Resp({"mode": "kontakt", "query": "x", "treffer": []})
        with mock.patch.object(vault_client.urllib.request, "urlopen", side_effect=fake_urlopen):
            vault_client.lookup("kontakt", "x", vault="clara")
        self.assertEqual(captured["body"], {"mode": "kontakt", "query": "x", "vault": "clara"})

    def test_vault_omitted_when_none(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Resp({"mode": "kontakt", "query": "x", "treffer": []})
        with mock.patch.object(vault_client.urllib.request, "urlopen", side_effect=fake_urlopen):
            vault_client.lookup("kontakt", "x")
        self.assertNotIn("vault", captured["body"])

    def test_dokument_is_valid_mode(self):
        self.assertIn("dokument", vault_client.VALID_MODES)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && pytest test_vault_client.py -v`
Expected: FAIL — `test_vault_added_to_body_when_set` (kein `vault`-Param) und `test_dokument_is_valid_mode` (Modus fehlt).

- [ ] **Step 3: Write minimal implementation**

In `tools/voice-echo-bot/vault_client.py`:

Zeile 15 ersetzen:

```python
VALID_MODES = ("kontakt", "termin", "mail", "wissen", "dokument")
```

Funktion `lookup` (Zeilen 22–35) ersetzen:

```python
def lookup(mode, query, vault=None, url=VAULT_LOOKUP_URL, timeout=30):
    """Ruft den Vault-Lookup-Dienst auf und gibt das JSON-dict zurück.

    `vault` (z.B. "clara") wählt den Mandanten-Vault; fehlt er, gilt serverseitig
    der Default (whitestag)."""
    payload = {"mode": mode, "query": query}
    if vault:
        payload["vault"] = vault
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise VaultError("Vault-Lookup HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise VaultError("Vault-Lookup nicht erreichbar: {}".format(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise VaultError("Vault-Lookup Antwort nicht lesbar: {}".format(exc)) from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && pytest test_vault_client.py -v`
Expected: PASS (alle bestehenden + 3 neue Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/vault_client.py tools/voice-echo-bot/test_vault_client.py
git commit -m "feat(voice-echo): vault_client reicht vault-Selektor durch, dokument-Modus"
```

---

### Task 5: `bot.py` übergibt den Tenant-Vault

**Files:**
- Modify: `tools/voice-echo-bot/bot.py:247` (Aufruf in `_do_lookup`)
- Test: `tools/voice-echo-bot/test_bot.py` (Modify)

**Interfaces:**
- Consumes: `vault_client.lookup(mode, query, vault=...)` aus Task 4; `tenant`-Dict mit optionalem Key `"vault"`.

- [ ] **Step 1: Write the failing test**

In `tools/voice-echo-bot/test_bot.py` einen Test ergänzen, der prüft, dass `_do_lookup` den Tenant-Vault an `vault_client.lookup` weiterreicht. (Der genaue Bot-Konstruktor/Fixture-Stil ist an die bestehende `test_bot.py` anzupassen — dort existiert bereits Setup für ein Bot-Objekt. Folge diesem Muster; hier die Kern-Assertion:)

```python
    def test_do_lookup_passes_tenant_vault(self):
        bot = self._make_bot()  # bestehendes Fixture/Helper aus test_bot.py nutzen
        captured = {}
        def fake_lookup(mode, query, vault=None):
            captured["vault"] = vault
            return {"mode": mode, "query": query, "treffer": []}
        with mock.patch.object(bot_mod.vault_client, "lookup", side_effect=fake_lookup), \
             mock.patch.object(bot_mod.llm, "chat", return_value="fertig"):
            bot._do_lookup({"name": "Clara", "vault": "clara"}, [], "kontakt", "Jana")
        self.assertEqual(captured["vault"], "clara")
```

Falls `test_bot.py` das Bot-Objekt anders erzeugt (Modulname `bot` statt `bot_mod`, anderes Fixture): den Import/Helper an die dort vorhandene Konvention angleichen. Ziel-Assertion bleibt: `captured["vault"] == "clara"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && pytest test_bot.py -k tenant_vault -v`
Expected: FAIL — `captured["vault"]` ist `None` (Aufruf reicht `vault` noch nicht durch).

- [ ] **Step 3: Write minimal implementation**

In `tools/voice-echo-bot/bot.py`, Zeile 247, ersetzen:

```python
            result = vault_client.lookup(mode, query, vault=tenant.get("vault"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && pytest test_bot.py -k tenant_vault -v`
Expected: PASS

Danach die volle Bot-Suite:

Run: `cd tools/voice-echo-bot && pytest -v`
Expected: PASS (keine Regression)

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/bot.py tools/voice-echo-bot/test_bot.py
git commit -m "feat(voice-echo): _do_lookup reicht Tenant-Vault an vault_client durch"
```

---

### Task 6: Tenants-Feld, Deployment, Live-Verifikation

Bringt die deployten Kopien auf Stand, ergänzt die `vault`-Felder und verifiziert live gegen `:7788`. Keine Unit-Tests — Deliverable ist der laufende, verifizierte Dienst.

**Files:**
- Modify: `~/.paperclip/voice-echo-tenants.json`
- Deploy: `~/.paperclip/scripts/vault-lookup/{server.py,vault_lookup.py}`, `~/.paperclip/scripts/voice-echo-bot/{bot.py,vault_client.py}`

- [ ] **Step 1: `vault`-Felder in die deployte Tenants-Tabelle**

`~/.paperclip/voice-echo-tenants.json` so ergänzen, dass der Walter-Tenant `"vault": "whitestag"` und der Clara-Tenant `"vault": "clara"` bekommt (übrige Felder unverändert):

```json
{
  "8311805232": {
    "name": "Walter / WHITESTAG",
    "company_id": "9cebf3cf-efe8-4597-a400-f06488900a87",
    "ceo_agent_id": "506c873e-3a40-4483-9a45-0eb0fa1554bb",
    "vault": "whitestag"
  },
  "1220010628": {
    "name": "Clara / Clara Sound",
    "company_id": "0e426844-309c-4528-9aa5-90ff76790a51",
    "ceo_agent_id": "64ad7d03-ce64-46aa-ae79-d17ff26f5d4f",
    "vault": "clara"
  }
}
```

- [ ] **Step 2: Deployte Kopien spiegeln**

```bash
SRC="/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip/tools"
cp "$SRC/vault-lookup/vault_lookup.py" ~/.paperclip/scripts/vault-lookup/vault_lookup.py
cp "$SRC/vault-lookup/server.py"       ~/.paperclip/scripts/vault-lookup/server.py
cp "$SRC/voice-echo-bot/bot.py"          ~/.paperclip/scripts/voice-echo-bot/bot.py
cp "$SRC/voice-echo-bot/vault_client.py" ~/.paperclip/scripts/voice-echo-bot/vault_client.py
```

- [ ] **Step 3: LaunchAgents neu starten**

```bash
launchctl kickstart -k "gui/$(id -u)/de.whitestag.vault-lookup"
launchctl kickstart -k "gui/$(id -u)/de.whitestag.voice-echo-bot"
```

- [ ] **Step 4: Live-Verifikation gegen `:7788`**

WHITESTAG (Default, ohne `vault`) — muss WHITESTAG-Quellen liefern:

```bash
curl -s -m 20 -X POST http://127.0.0.1:7788/lookup \
  -H 'Content-Type: application/json' \
  -d '{"mode":"kontakt","query":"Jana"}' | python3 -m json.tool
```
Expected: `treffer[].quelle` zeigt Pfade **ohne** Clara-Bezug (WHITESTAG-Vault).

Clara — muss Clara-Quellen liefern:

```bash
curl -s -m 20 -X POST http://127.0.0.1:7788/lookup \
  -H 'Content-Type: application/json' \
  -d '{"mode":"dokument","query":"Clara","vault":"clara"}' | python3 -m json.tool
```
Expected: HTTP-Antwort mit `treffer` aus dem Clara-Vault (oder leer, falls kein Match) — **kein** `fehler`, und keine WHITESTAG-Pfade.

Gegenprobe Isolation — dieselbe Clara-Abfrage ohne `vault` darf **keine** Clara-Daten liefern (Default WHITESTAG).

- [ ] **Step 5: Optionaler End-to-End-Check**

Aus Claras Telegram-Chat (`1220010628`) Jarvis nach einem Kontakt/Dokument fragen, das es nur im Clara-Vault gibt → Antwort muss aus Clara-Daten stammen. (Manuell durch Walter/Clara; nicht automatisierbar.)

- [ ] **Step 6: Commit (Doku/Deploy-Notiz, falls Quelle der Tenants-Tabelle o.ä. versioniert wird)**

Die deployten Dateien und `~/.paperclip/voice-echo-tenants.json` liegen außerhalb des Repos — kein Git-Commit nötig. Falls im Repo eine Referenz-/Beispiel-Tenants-Datei oder `DEPLOY.md` existiert, dort den `vault`-Key dokumentieren:

```bash
git add tools/voice-echo-bot/DEPLOY.md
git commit -m "docs(voice-echo): vault-Feld pro Tenant im DEPLOY dokumentiert"
```

---

## Self-Review

**Spec coverage:**
- Registry + `resolve_vault` → Task 1. ✓
- `vault_lookup.py` cfg-Threading (alle 5 Modi) + Dispatcher → Task 2. ✓
- `server.py` reicht `vault` → Task 3. ✓
- `vault_client.py` `vault`-Param + `dokument` in `VALID_MODES` → Task 4. ✓
- `bot.py` übergibt Tenant-Vault → Task 5. ✓
- `tenants.json` `vault`-Felder + Deployment + Live-Verifikation → Task 6. ✓
- Fail-safe (`os.path.isdir`) bleibt in allen Funktionen erhalten (Task 2). ✓
- Sicherheit/Default `whitestag`: Rückwärtskompatibilitäts-Tests in Task 2 (`test_default_reads_whitestag_vault`) und Task 4 (`test_vault_omitted_when_none`). ✓
- Tests (Registry-Auflösung, Routing, Rückwärtskompatibilität) → Task 1/2/4. ✓

**Placeholder scan:** Task 5 verweist bewusst auf das bestehende Bot-Fixture in `test_bot.py` statt es zu erfinden (der Implementierer liest die Datei); Kern-Assertion ist konkret angegeben. Sonst keine Platzhalter.

**Type consistency:** `resolve_vault(vault)`, `lookup(mode, query, vault=DEFAULT_VAULT)`, `vault_client.lookup(mode, query, vault=None)`, `tenant.get("vault")`, cfg-Keys `path`/`brain_url`/`brain_token` durchgängig identisch verwendet. ✓
