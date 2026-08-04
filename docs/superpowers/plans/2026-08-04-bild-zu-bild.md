# Bild→Bild im Bilddienst — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Paperclip-Bilddienst nimmt Aufträge mit `modell: qwenedit` an, lädt ein bis drei Bildanhänge des Issues auf den ComfyUI-Renderknoten und liefert das bearbeitete Bild als Anhang zurück.

**Architecture:** Bild→Bild wird ein dritter Renderpfad neben `render_local` und `render_openai`. Die Quellbilder kommen über die Paperclip-Attachment-API herein und per `POST /upload/image` auf den Knoten; eine einzige Workflow-Vorlage bedient ein, zwei oder drei Bilder, weil `image1..3` an `TextEncodeQwenImageEditPlus` optional sind — ungenutzte Slots werden vor dem Absenden aus dem Workflow herausgeschnitten. Das Einsammeln der Ergebnisse bleibt unverändert.

**Tech Stack:** Python (nur Standardbibliothek), pytest, ComfyUI-HTTP-API, Paperclip-REST-API.

**Spec:** [`../specs/2026-08-04-bild-zu-bild-design.md`](../specs/2026-08-04-bild-zu-bild-design.md)

## Global Constraints

- **Arbeitsverzeichnis:** `tools/bild-service/` **im Repo** — das ist die Quelle. Einmal setzen:
  `export PAPERCLIP_REPO="/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip"`
- **Deploy ist ein eigener Schritt:** `"$PAPERCLIP_REPO/tools/bild-service/deploy.sh"` kopiert `*.py` und `workflows/*.json` nach `~/.paperclip/scripts/bild-service/`. Grund: macOS-launchd kann CloudStorage/SynologyDrive nicht lesen. **Wer nur im Repo ändert, ändert am laufenden Dienst nichts** — und wer nur live ändert, verliert es beim nächsten Deploy. Nach dem Deploy greift der Dienst den Stand im nächsten Zyklus (≤ 60 s).
- **Nie direkt in `~/.paperclip/scripts/bild-service/` editieren.** Beide Stände waren am 04.08. deckungsgleich (`diff -rq`; einzige Unterschiede `deploy.sh` und `node/`, die bewusst nicht mitgehen). Das soll so bleiben.
- **Nach jeder Aufgabe committen.** Das Repo ist versioniert, Branch `feat/wake-word-jarvis-satellite`.
- **Python 3.9** (`/usr/bin/python3`, so startet launchd den Dienst). Kein `X | None`, kein `match`, keine `dict | dict`-Vereinigung.
- **Nur Standardbibliothek.** Keine neuen Abhängigkeiten, keine `requests`.
- **Netzfrei testbar:** Antwort-Auswertung immer in eigene Funktionen ohne HTTP, wie in `comfy_client.parse_history` vorgemacht. Tests laufen ohne Server und ohne Knoten.
- **Tests laufen mit:** `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
- **Deutsche Kommentare und Meldungen**, wie im Bestand. Kommentare erklären das *Warum*, nicht das *Was*.
- **Kein Umbau des Bestehenden.** `render_local`, `render_openai` und `collect_one` bleiben in ihrer Funktion unangetastet; nur klar benannte Ergänzungen.
- **Modellname im Brief:** `qwenedit`. Vorlage: `workflows/qwen-edit.api.json`.
- **Grenzen:** höchstens 3 Quellbilder, je höchstens 20 MB.

## File Structure

Alle Pfade relativ zu `tools/bild-service/` **im Repo** (nicht im Live-Ordner):

| Datei | Verantwortung | Status |
|---|---|---|
| `config.py` | Konstanten: Modellnamen, Vorlagenzuordnung, Grenzen, Zeitlimits | ändern |
| `brief_parser.py` | Text des Issues → Auftragsfelder, netzfrei | ändern |
| `sources.py` | Auswahl, Sortierung und Prüfung der Quellbilder aus der Anhangsliste, netzfrei | **neu** |
| `paperclip_api.py` | HTTP zu Paperclip: Anhänge auflisten und laden | ändern |
| `comfy_client.py` | HTTP zum Knoten: Bild hochladen | ändern |
| `workflow_template.py` | Vorlage laden, Platzhalter setzen, ungenutzte Bild-Slots entfernen | ändern |
| `workflows/qwen-edit.api.json` | Workflow-Vorlage für Qwen-Image-Edit | **neu** |
| `job_state.py` | laufende Aufträge, jetzt inkl. hochgeladener Quellbildnamen | ändern |
| `bild_service.py` | Ablaufsteuerung: neuer Pfad `render_edit`, Wiederholversuch | ändern |

`sources.py` ist bewusst ein eigenes Modul: Die Auswahllogik (nur Bilder, Reihenfolge, Grenzen) ist die Stelle mit den meisten Fehlerfällen und muss ohne HTTP prüfbar sein — genau wie `brief_parser.py`.

---

### Task 1: `qwenedit` im Brief

**Files:**
- Modify: `tools/bild-service/config.py`
- Modify: `tools/bild-service/brief_parser.py`
- Test: `tools/bild-service/test_brief_parser.py`

**Interfaces:**
- Consumes: nichts (erste Aufgabe)
- Produces:
  - `config.ALLOWED_MODELS` enthält `"qwenedit"`
  - `config.LOCAL_WORKFLOWS["qwenedit"] == "qwen-edit"`
  - `config.EDIT_MODELS == {"qwenedit"}` — Modelle, die Quellbilder brauchen
  - `config.MAX_SOURCE_IMAGES == 3`, `config.MAX_SOURCE_BYTES == 20 * 1024 * 1024`
  - `config.MODEL_JOB_TIMEOUT_SEC["qwenedit"] == 600`
  - `parse_brief(text)` liefert zusätzlich den Schlüssel `"format_ignored"` (bool)

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `test_brief_parser.py` anhängen:

```python
def test_qwenedit_wird_angenommen():
    b = parse_brief("prompt: entferne die Person\nmodell: qwenedit")
    assert b["error"] is None
    assert b["modell"] == "qwenedit"


def test_qwenedit_ignoriert_format_und_meldet_es():
    """Die Ausgabegroesse folgt dem Quellbild -- ein angegebenes format waere
    eine stille Luege, deshalb wird es sichtbar verworfen."""
    b = parse_brief("prompt: x\nmodell: qwenedit\nformat: 1536x1024")
    assert b["format_ignored"] is True


def test_ohne_format_kein_hinweis():
    b = parse_brief("prompt: x\nmodell: qwenedit")
    assert b["format_ignored"] is False


def test_format_bei_normalem_modell_gilt_weiter():
    b = parse_brief("prompt: x\nmodell: qwen\nformat: 1536x1024")
    assert b["format_ignored"] is False
    assert b["size"] == "1536x1024"


def test_tippfehler_im_modell_faellt_weiter_auf_qwen():
    b = parse_brief("prompt: x\nmodell: qwenedti")
    assert b["modell"] == "qwen"
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_brief_parser.py -q`
Expected: FAIL — `KeyError: 'format_ignored'` bzw. `assert 'qwen' == 'qwenedit'`

- [ ] **Step 3: `config.py` erweitern**

`ALLOWED_MODELS` und `LOCAL_WORKFLOWS` ersetzen, danach die neuen Konstanten ergänzen:

```python
ALLOWED_MODELS = {"qwen", "qwen360", "qwenedit", "openai"}
DEFAULT_MODEL = "qwen"

LOCAL_WORKFLOWS = {
    "qwen": "qwen-image",
    "qwen360": "qwen-360",
    "qwenedit": "qwen-edit",
}

# Modelle, die ein oder mehrere Quellbilder brauchen. Ohne Anhang ist der
# Auftrag nicht ausfuehrbar -- das ist kein Standardfall, sondern ein Abbruch.
EDIT_MODELS = {"qwenedit"}
MAX_SOURCE_IMAGES = 3
MAX_SOURCE_BYTES = 20 * 1024 * 1024
```

In `MODEL_JOB_TIMEOUT_SEC` den Eintrag ergänzen:

```python
MODEL_JOB_TIMEOUT_SEC = {"qwen360": 900, "qwenedit": 600}
```

- [ ] **Step 4: `brief_parser.py` erweitern**

Import-Zeile oben ergänzen um `EDIT_MODELS`:

```python
from config import (ALLOWED_QUALITIES, DEFAULT_QUALITY,
                    ALLOWED_FORMATS, DEFAULT_FORMAT, MODEL_FORMATS,
                    ALLOWED_MODELS, DEFAULT_MODEL, OPENAI_FORMAT_MAP, MAX_SEED,
                    EDIT_MODELS)
```

`_result` um den neuen Schlüssel erweitern (Signatur und Rückgabe):

```python
def _result(error, prompt, fmt, quality, background, modell, seed,
            format_ignored=False):
    width, height = (int(p) for p in fmt.split("x"))
    return {
        "error": error,
        "prompt": prompt,
        "modell": modell,
        "size": fmt,
        "width": width,
        "height": height,
        "openai_size": OPENAI_FORMAT_MAP.get(fmt, fmt),
        "quality": quality,
        "background": background,
        "seed": seed,
        "format_ignored": format_ignored,
    }
```

In `parse_brief` den Format-Block ersetzen (er steht direkt nach der Modellwahl):

```python
    # Bei Bild->Bild bestimmt das Quellbild die Ausgabegroesse. Ein trotzdem
    # angegebenes 'format' wird verworfen -- aber sichtbar, nicht still.
    format_ignored = False
    if modell in EDIT_MODELS:
        format_ignored = bool(fields.get("format") or fields.get("size"))
        fmt = DEFAULT_FORMAT
    else:
        spec = MODEL_FORMATS.get(modell)
        allowed = spec["allowed"] if spec else ALLOWED_FORMATS
        fallback = spec["default"] if spec else DEFAULT_FORMAT
        # 'format' ist der Name laut Spec, 'size' bleibt als Alias erlaubt,
        # damit bestehende Auftraege nicht brechen.
        fmt = fields.get("format") or fields.get("size") or fallback
        if fmt not in allowed:
            fmt = fallback
```

Und die Rückgabe am Ende:

```python
    return _result(None, prompt, fmt, quality,
                   "transparent" if transparent else "opaque",
                   modell, _seed(fields.get("seed")), format_ignored)
```

Der frühe Fehler-Rückgabepfad (fehlender Prompt) bleibt unverändert — `format_ignored` bekommt dort den Vorgabewert `False`.

- [ ] **Step 5: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS, alle bisherigen Tests weiterhin grün

- [ ] **Step 6: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/config.py tools/bild-service/brief_parser.py \
        tools/bild-service/test_brief_parser.py
git commit -m "feat(bild-service): Modell qwenedit im Brief annehmen"
```

Noch **kein** Deploy — der Dienst bekommt den neuen Modellnamen erst, wenn der
Renderpfad dazu existiert (Task 6). Sonst nähme er `qwenedit`-Aufträge an und
renderte sie über `render_local` als normales Bild.

---

### Task 2: Quellbilder auswählen (`sources.py`)

**Files:**
- Create: `tools/bild-service/sources.py`
- Test: `tools/bild-service/test_sources.py` (neu)

**Interfaces:**
- Consumes: `config.MAX_SOURCE_IMAGES`, `config.MAX_SOURCE_BYTES` (Task 1)
- Produces: `sources.pick_source_images(attachments)` → `(images, error)`.
  `images` ist eine Liste der Anhang-Dicts, **aufsteigend nach `createdAt`**;
  `error` ist `None` oder ein deutscher Meldungstext. Bei `error` ist `images` leer.

**Hintergrund:** `GET /api/issues/{id}/attachments` liefert `orderBy(desc(createdAt))` — **neuestes zuerst**. `createdAt` ist ein ISO-8601-String mit `Z` (am 04.08. an einer echten Antwort geprüft: `"2026-08-03T13:28:30.860Z"`), sortiert also lexikografisch korrekt. Ohne Umkehrung wäre „Bild 1" das *zuletzt* angehängte Bild.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Neue Datei `test_sources.py`:

```python
import sources


def _att(id_, created, ctype="image/png", size=1000):
    return {"id": id_, "createdAt": created, "contentType": ctype,
            "byteSize": size, "originalFilename": id_ + ".png"}


def test_kehrt_die_absteigende_reihenfolge_der_api_um():
    """Die API liefert desc(createdAt). Ohne Umkehrung waere 'Bild 1' das
    ZULETZT angehaengte Bild -- genau falsch herum."""
    api_antwort = [_att("neu", "2026-08-04T10:00:00.000Z"),
                   _att("alt", "2026-08-04T09:00:00.000Z")]
    imgs, err = sources.pick_source_images(api_antwort)
    assert err is None
    assert [i["id"] for i in imgs] == ["alt", "neu"]


def test_gleicher_zeitstempel_sortiert_stabil_nach_id():
    a = [_att("b", "2026-08-04T10:00:00.000Z"),
         _att("a", "2026-08-04T10:00:00.000Z")]
    imgs, err = sources.pick_source_images(a)
    assert err is None
    assert [i["id"] for i in imgs] == ["a", "b"]


def test_nicht_bilder_zaehlen_nicht_mit():
    a = [_att("pdf", "2026-08-04T09:00:00.000Z", ctype="application/pdf"),
         _att("bild", "2026-08-04T10:00:00.000Z")]
    imgs, err = sources.pick_source_images(a)
    assert err is None
    assert [i["id"] for i in imgs] == ["bild"]


def test_ohne_bild_gibt_fehler():
    imgs, err = sources.pick_source_images([])
    assert imgs == []
    assert "Bildanhang" in err


def test_vier_bilder_werden_abgelehnt_statt_gekuerzt():
    """Stilles Kuerzen waere schlimmer als ein Abbruch: 'Bild 2' im Prompt
    meint dann etwas anderes, als der Besteller sieht."""
    a = [_att(str(n), "2026-08-04T0%d:00:00.000Z" % n) for n in range(1, 5)]
    imgs, err = sources.pick_source_images(a)
    assert imgs == []
    assert "4" in err


def test_zu_grosses_bild_wird_abgelehnt():
    a = [_att("gross", "2026-08-04T09:00:00.000Z", size=21 * 1024 * 1024)]
    imgs, err = sources.pick_source_images(a)
    assert imgs == []
    assert "gross.png" in err


def test_fehlender_contenttype_gilt_nicht_als_bild():
    a = [{"id": "x", "createdAt": "2026-08-04T09:00:00.000Z",
          "byteSize": 10, "originalFilename": "x.png"}]
    imgs, err = sources.pick_source_images(a)
    assert imgs == []
    assert err is not None
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_sources.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'sources'`

- [ ] **Step 3: `sources.py` schreiben**

```python
"""Auswahl der Quellbilder eines Bild->Bild-Auftrags. Kennt kein HTTP.

Die Anhangsliste kommt so, wie Paperclip sie liefert -- absteigend nach
createdAt. Hier wird sie in die Reihenfolge gebracht, in der ein Mensch die
Bilder angehaengt hat, und auf die Grenzen des Dienstes geprueft.
"""
from config import MAX_SOURCE_IMAGES, MAX_SOURCE_BYTES


def _ist_bild(att):
    return str(att.get("contentType") or "").lower().startswith("image/")


def _name(att):
    return att.get("originalFilename") or att.get("id") or "?"


def pick_source_images(attachments):
    """-> (images, error).

    images: Bildanhaenge aufsteigend nach createdAt (aeltester zuerst = 'Bild 1').
    error:  None oder eine deutsche Meldung; dann ist images leer.
    """
    bilder = [a for a in (attachments or []) if _ist_bild(a)]
    # Zweitschluessel id: bei gleichem Zeitstempel waere die Reihenfolge sonst
    # von der Datenbank abhaengig und damit zwischen zwei Laeufen verschieden.
    bilder.sort(key=lambda a: (str(a.get("createdAt") or ""), str(a.get("id") or "")))

    if not bilder:
        return [], ("Kein Bildanhang am Issue. 'modell: qwenedit' braucht "
                    "mindestens ein Bild als Anhang.")
    if len(bilder) > MAX_SOURCE_IMAGES:
        return [], ("%d Bildanhänge am Issue, erlaubt sind höchstens %d. "
                    "Bitte die überzähligen entfernen — der Dienst kürzt "
                    "bewusst nicht selbst, weil sich sonst die Bedeutung von "
                    "'Bild 1'/'Bild 2' im Prompt verschiebt."
                    % (len(bilder), MAX_SOURCE_IMAGES))
    zu_gross = [a for a in bilder if int(a.get("byteSize") or 0) > MAX_SOURCE_BYTES]
    if zu_gross:
        return [], ("Anhang zu groß: %s (%.1f MB, erlaubt sind %d MB)."
                    % (_name(zu_gross[0]),
                       int(zu_gross[0].get("byteSize") or 0) / 1048576.0,
                       MAX_SOURCE_BYTES // 1048576))
    return bilder, None
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_sources.py -q`
Expected: PASS (7 Tests)

- [ ] **Step 5: Gesamtsuite laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS

- [ ] **Step 6: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/sources.py tools/bild-service/test_sources.py
git commit -m "feat(bild-service): Quellbilder auswaehlen, sortieren und pruefen"
```

---

### Task 3: Anhänge aus Paperclip holen

**Files:**
- Modify: `tools/bild-service/paperclip_api.py`
- Test: `tools/bild-service/test_paperclip_api.py`

**Interfaces:**
- Consumes: `paperclip_api._request`, `paperclip_api._token`, `AuthError`, `PaperclipError` (Bestand)
- Produces:
  - `paperclip_api.list_attachments(issue_id)` → Liste von Anhang-Dicts (JSON der API, unverändert)
  - `paperclip_api.fetch_attachment(attachment_id)` → `bytes`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `test_paperclip_api.py` anhängen:

```python
def test_list_attachments_ruft_den_richtigen_pfad(monkeypatch):
    _patch_token(monkeypatch)
    gesehen = {}

    def fake_urlopen(req, *a, **k):
        gesehen["url"] = req.full_url
        return _FakeResp(json.dumps([{"id": "att-1"}]).encode())

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", fake_urlopen)
    res = paperclip_api.list_attachments("issue-9")
    assert res == [{"id": "att-1"}]
    assert gesehen["url"].endswith("/api/issues/issue-9/attachments")


def test_fetch_attachment_liefert_rohe_bytes(monkeypatch):
    """Darf NICHT durch json.loads laufen -- das wuerde ein PNG zerreissen."""
    _patch_token(monkeypatch)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20

    def fake_urlopen(req, *a, **k):
        return _FakeResp(png)

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", fake_urlopen)
    assert paperclip_api.fetch_attachment("att-1") == png


def test_fetch_attachment_401_ist_autherror(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 401, "Unauthorized", {},
                                     io.BytesIO(b""))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.AuthError):
        paperclip_api.fetch_attachment("att-1")


def test_fetch_attachment_500_ist_paperclip_error(monkeypatch):
    _patch_token(monkeypatch)

    def raise_http(*a, **k):
        raise urllib.error.HTTPError("http://x", 500, "Server Error", {},
                                     io.BytesIO(b"kaputt"))

    monkeypatch.setattr(paperclip_api.urllib.request, "urlopen", raise_http)
    with pytest.raises(paperclip_api.PaperclipError):
        paperclip_api.fetch_attachment("att-1")
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_paperclip_api.py -q`
Expected: FAIL — `AttributeError: module 'paperclip_api' has no attribute 'list_attachments'`

- [ ] **Step 3: Implementieren**

In `paperclip_api.py` nach `get_issue` einfügen:

```python
def list_attachments(issue_id):
    return _request("GET", "/api/issues/%s/attachments" % issue_id)


def fetch_attachment(attachment_id):
    """Rohe Bytes eines Anhangs.

    Geht bewusst NICHT durch _request(): das dortige json.loads() wuerde ein
    PNG als kaputtes JSON abweisen.
    """
    url = PAPERCLIP_BASE + "/api/attachments/%s/content" % attachment_id
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _token()})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError("Paperclip %s — Board-Token abgelaufen." % e.code)
        raise PaperclipError("Paperclip GET Anhang %s: HTTP %s: %s"
                             % (attachment_id, e.code,
                                e.read().decode(errors="replace")[:300]))
    except urllib.error.URLError as e:
        raise PaperclipError("Paperclip GET Anhang %s: nicht erreichbar: %s"
                             % (attachment_id, e))
    except OSError as e:
        raise PaperclipError("Paperclip GET Anhang %s: OS-Fehler: %s"
                             % (attachment_id, e))
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS

- [ ] **Step 5: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/paperclip_api.py tools/bild-service/test_paperclip_api.py
git commit -m "feat(bild-service): Anhaenge eines Issues auflisten und laden"
```

---

### Task 4: Bild auf den Knoten hochladen

**Files:**
- Modify: `tools/bild-service/comfy_client.py`
- Test: `tools/bild-service/test_comfy_client.py`

**Interfaces:**
- Consumes: `comfy_client.ComfyError`, `config.COMFY_BASE`, `config.COMFY_HTTP_TIMEOUT` (Bestand)
- Produces:
  - `comfy_client.parse_upload_response(data)` → `str` (Name, ggf. `"unterordner/name.png"`)
  - `comfy_client.upload_image(filename, content)` → `str` (derselbe Name, wie ihn `LoadImage` erwartet)

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `test_comfy_client.py` anhängen:

```python
def test_parse_upload_response_liefert_namen():
    assert cc.parse_upload_response({"name": "a.png", "subfolder": "", "type": "input"}) == "a.png"


def test_parse_upload_response_beruecksichtigt_unterordner():
    """LoadImage erwartet 'unterordner/name', wenn ComfyUI einen vergibt."""
    got = cc.parse_upload_response({"name": "a.png", "subfolder": "sub", "type": "input"})
    assert got == "sub/a.png"


def test_parse_upload_response_ohne_namen_raises():
    with pytest.raises(cc.ComfyError):
        cc.parse_upload_response({"error": "kaputt"})


def test_upload_image_baut_multipart_und_liefert_namen():
    import urllib.request
    original = urllib.request.urlopen
    gesehen = {}

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self):
            return b'{"name": "quelle.png", "subfolder": "", "type": "input"}'

    def fake_urlopen(req, *a, **k):
        gesehen["url"] = req.full_url
        gesehen["ctype"] = req.headers.get("Content-type")
        gesehen["body"] = req.data
        return FakeResponse()

    try:
        urllib.request.urlopen = fake_urlopen
        name = cc.upload_image("quelle.png", b"BILDDATEN")
    finally:
        urllib.request.urlopen = original

    assert name == "quelle.png"
    assert gesehen["url"].endswith("/upload/image")
    assert gesehen["ctype"].startswith("multipart/form-data; boundary=")
    assert b'name="image"; filename="quelle.png"' in gesehen["body"]
    assert b"BILDDATEN" in gesehen["body"]


def test_upload_image_http_fehler_wird_comfy_error():
    import urllib.error
    import urllib.request
    original = urllib.request.urlopen

    def fake_urlopen(*a, **k):
        raise urllib.error.HTTPError("http://x", 413, "Too Large", {}, None)

    try:
        urllib.request.urlopen = fake_urlopen
        with pytest.raises(cc.ComfyError):
            cc.upload_image("a.png", b"x")
    finally:
        urllib.request.urlopen = original
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_comfy_client.py -q`
Expected: FAIL — `AttributeError: module 'comfy_client' has no attribute 'parse_upload_response'`

- [ ] **Step 3: Implementieren**

Oben in `comfy_client.py` den Import ergänzen:

```python
import uuid
```

Dann ans Ende der Datei:

```python
def parse_upload_response(data):
    name = (data or {}).get("name")
    if not name:
        raise ComfyError("ComfyUI lieferte keinen Dateinamen beim Upload: %s"
                         % json.dumps(data)[:300])
    sub = (data or {}).get("subfolder") or ""
    # LoadImage erwartet den Unterordner im Namen, nicht als eigenes Feld.
    return "%s/%s" % (sub, name) if sub else name


def upload_image(filename, content):
    """Quellbild in den input-Ordner des Knotens legen.

    Rueckgabe ist der Name, den der Knoten VERGEBEN hat -- nicht der
    uebergebene: bei Namensgleichheit haengt ComfyUI eine Nummer an, und
    LoadImage findet die Datei sonst nicht.
    """
    boundary = "----bild" + uuid.uuid4().hex
    pre = ("--%s\r\n"
           'Content-Disposition: form-data; name="image"; filename="%s"\r\n'
           "Content-Type: application/octet-stream\r\n\r\n" % (boundary, filename)).encode()
    mid = ("\r\n--%s\r\n"
           'Content-Disposition: form-data; name="type"\r\n\r\ninput' % boundary).encode()
    post = ("\r\n--%s--\r\n" % boundary).encode()
    body = pre + content + mid + post
    req = urllib.request.Request(
        COMFY_BASE + "/upload/image", data=body,
        headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            try:
                return parse_upload_response(json.loads(raw))
            except ValueError:
                raise ComfyError("ComfyUI antwortet ungültiges JSON auf /upload/image: %s"
                                 % raw.decode(errors="replace")[:200])
    except urllib.error.HTTPError as e:
        raise ComfyError("ComfyUI HTTP %s beim Upload von %s" % (e.code, filename))
    except (urllib.error.URLError, OSError) as e:
        raise ComfyError("ComfyUI nicht erreichbar (/upload/image): %s" % e)
```

Das Zeitlimit ist hier bewusst 120 s statt der üblichen 30 — ein 20-MB-Bild über WLAN braucht länger als ein JSON-Aufruf.

- [ ] **Step 4: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS

- [ ] **Step 5: Gegen den echten Knoten prüfen**

```bash
cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -c "
import comfy_client as cc
# 1x1-PNG, damit nichts Grosses auf dem Knoten landet
png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000a49444154789c6300010000050001'
                    '0d0a2db40000000049454e44ae426082')
print(cc.upload_image('rauchtest-1x1.png', png))
"
```
Expected: ein Dateiname wie `rauchtest-1x1.png` (oder mit angehängter Nummer bei Wiederholung)

- [ ] **Step 6: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/comfy_client.py tools/bild-service/test_comfy_client.py
git commit -m "feat(bild-service): Quellbild auf den Renderknoten hochladen"
```

---

### Task 5: Workflow-Vorlage und Bild-Slots

**Files:**
- Create: `tools/bild-service/workflows/qwen-edit.api.json`
- Modify: `tools/bild-service/workflow_template.py`
- Test: `tools/bild-service/test_workflow_template.py`

**Interfaces:**
- Consumes: `workflow_template.load_raw`, `workflow_template.fill` (Bestand)
- Produces:
  - `workflow_template.IMAGE_PLACEHOLDERS == ("__IMAGE1__", "__IMAGE2__", "__IMAGE3__")`
  - `workflow_template.set_images(workflow, names)` → das veränderte Workflow-Dict.
    `workflow` ist das Ergebnis von `fill()`, `names` eine Liste von 1–3 Dateinamen.
  - `fill(raw, prompt, seed, width=0, height=0)` — Breite/Höhe jetzt optional

- [ ] **Step 1: Die Vorlage anlegen**

`workflows/qwen-edit.api.json`:

```json
{
  "1": {"class_type": "UNETLoader",
        "inputs": {"unet_name": "qwen_image_edit_2511_int8_convrot.safetensors", "weight_dtype": "default"}},
  "2": {"class_type": "CLIPLoader",
        "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image"}},
  "3": {"class_type": "VAELoader",
        "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
  "4": {"class_type": "LoraLoaderModelOnly",
        "inputs": {"model": ["1", 0],
                   "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
                   "strength_model": 1.0}},
  "5": {"class_type": "ModelSamplingAuraFlow",
        "inputs": {"model": ["4", 0], "shift": 3.1}},
  "6": {"class_type": "TextEncodeQwenImageEditPlus",
        "inputs": {"clip": ["2", 0], "prompt": "__PROMPT__", "vae": ["3", 0],
                   "image1": ["21", 0], "image2": ["23", 0], "image3": ["25", 0]}},
  "7": {"class_type": "TextEncodeQwenImageEditPlus",
        "inputs": {"clip": ["2", 0], "prompt": "", "vae": ["3", 0],
                   "image1": ["21", 0], "image2": ["23", 0], "image3": ["25", 0]}},
  "8": {"class_type": "VAEEncode",
        "inputs": {"pixels": ["21", 0], "vae": ["3", 0]}},
  "9": {"class_type": "KSampler",
        "inputs": {"model": ["5", 0], "seed": __SEED__, "steps": 4, "cfg": 1.0,
                   "sampler_name": "euler", "scheduler": "simple",
                   "positive": ["6", 0], "negative": ["7", 0],
                   "latent_image": ["8", 0], "denoise": 1.0}},
  "10": {"class_type": "VAEDecode",
         "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
  "11": {"class_type": "SaveImage",
         "inputs": {"images": ["10", 0], "filename_prefix": "whitestag-edit"}},
  "20": {"class_type": "LoadImage", "inputs": {"image": "__IMAGE1__"}},
  "21": {"class_type": "ImageScaleToTotalPixels",
         "inputs": {"image": ["20", 0], "upscale_method": "lanczos",
                    "megapixels": 1.0, "resolution_steps": 16}},
  "22": {"class_type": "LoadImage", "inputs": {"image": "__IMAGE2__"}},
  "23": {"class_type": "ImageScaleToTotalPixels",
         "inputs": {"image": ["22", 0], "upscale_method": "lanczos",
                    "megapixels": 1.0, "resolution_steps": 16}},
  "24": {"class_type": "LoadImage", "inputs": {"image": "__IMAGE3__"}},
  "25": {"class_type": "ImageScaleToTotalPixels",
         "inputs": {"image": ["24", 0], "upscale_method": "lanczos",
                    "megapixels": 1.0, "resolution_steps": 16}}
}
```

Die Ausgabegröße folgt Node 8 (`VAEEncode` auf dem **ersten** skalierten Quellbild) — deshalb braucht die Vorlage weder `__WIDTH__` noch `__HEIGHT__`.

- [ ] **Step 2: Den fehlschlagenden Test schreiben**

An `test_workflow_template.py` anhängen:

```python
def test_edit_vorlage_hat_bild_platzhalter():
    raw = wt.load_raw("qwen-edit")
    for ph in wt.IMAGE_PLACEHOLDERS:
        assert ph in raw
    assert "__PROMPT__" in raw and "__SEED__" in raw


def test_edit_vorlage_nutzt_das_edit_modell():
    """Zeigt die Vorlage auf das normale Modell, rendert sie still ein neues
    Bild statt das Quellbild zu bearbeiten."""
    wf = wt.fill(wt.load_raw("qwen-edit"), "x", 1)
    assert "edit" in wf["1"]["inputs"]["unet_name"]
    normal = wt.fill(wt.load_raw("qwen-image"), "x", 1, 1024, 1024)
    assert "edit" not in normal["1"]["inputs"]["unet_name"]


def test_set_images_mit_drei_bildern_setzt_alle():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1),
                       ["a.png", "b.png", "c.png"])
    assert wf["20"]["inputs"]["image"] == "a.png"
    assert wf["22"]["inputs"]["image"] == "b.png"
    assert wf["24"]["inputs"]["image"] == "c.png"
    assert "__IMAGE" not in json.dumps(wf)


def test_set_images_mit_einem_bild_entfernt_die_anderen():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png"])
    assert wf["20"]["inputs"]["image"] == "a.png"
    # Loader und Skalierer der ungenutzten Slots sind weg
    for tot in ("22", "23", "24", "25"):
        assert tot not in wf
    # und niemand verweist mehr auf sie
    assert "image2" not in wf["6"]["inputs"]
    assert "image3" not in wf["6"]["inputs"]
    assert "image2" not in wf["7"]["inputs"]
    assert "__IMAGE" not in json.dumps(wf)


def test_set_images_mit_zwei_bildern():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png", "b.png"])
    assert wf["20"]["inputs"]["image"] == "a.png"
    assert wf["22"]["inputs"]["image"] == "b.png"
    assert "24" not in wf and "25" not in wf
    assert wf["6"]["inputs"]["image2"] == ["23", 0]
    assert "image3" not in wf["6"]["inputs"]


def test_set_images_laesst_den_latent_pfad_stehen():
    """Die Ausgabegroesse haengt am VAEEncode des ersten Bildes -- faellt der
    weg, rendert der Sampler ins Leere."""
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png"])
    assert wf["8"]["inputs"]["pixels"] == ["21", 0]
    assert wf["9"]["inputs"]["latent_image"] == ["8", 0]


def test_set_images_ergebnis_bleibt_serialisierbar():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png"])
    assert json.loads(json.dumps(wf)) == wf
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_workflow_template.py -q`
Expected: FAIL — `AttributeError: module 'workflow_template' has no attribute 'IMAGE_PLACEHOLDERS'`

- [ ] **Step 4: `workflow_template.py` erweitern**

`fill` bekommt Vorgabewerte (die Edit-Vorlage hat keine Maße):

```python
def fill(raw, prompt, seed, width=0, height=0):
```

Der Rumpf bleibt unverändert — in einer Vorlage ohne `__WIDTH__`/`__HEIGHT__` laufen die beiden Ersetzungen folgenlos durch.

Danach ans Ende der Datei:

```python
IMAGE_PLACEHOLDERS = ("__IMAGE1__", "__IMAGE2__", "__IMAGE3__")


def _node_refs(node):
    """(Eingangsname, Ziel-Node-ID) fuer alle Verdrahtungen einer Node."""
    out = []
    for key, val in (node.get("inputs") or {}).items():
        if isinstance(val, list) and val and isinstance(val[0], str):
            out.append((key, val[0]))
    return out


def set_images(workflow, names):
    """Quellbilder in die Vorlage setzen und ungenutzte Slots herausschneiden.

    Die Node-IDs stehen bewusst NICHT im Code: welcher Loader zu welchem Slot
    gehoert, sagt allein der Platzhalter. So bleibt die Vorlage in der
    ComfyUI-App umbaubar, ohne dass hier etwas angefasst werden muss.
    """
    if not 1 <= len(names) <= len(IMAGE_PLACEHOLDERS):
        raise ValueError("1 bis %d Quellbilder erwartet, bekommen: %d"
                         % (len(IMAGE_PLACEHOLDERS), len(names)))

    # 1. Genutzte Slots belegen, ungenutzte Loader zum Abriss vormerken.
    tot = set()
    for i, ph in enumerate(IMAGE_PLACEHOLDERS):
        for nid, node in workflow.items():
            if (node.get("inputs") or {}).get("image") != ph:
                continue
            if i < len(names):
                node["inputs"]["image"] = names[i]
            else:
                tot.add(nid)

    # 2. Alles mitreissen, was NUR von abgerissenen Nodes lebt (der Skalierer
    #    hinter einem entfernten Loader haette sonst einen toten Eingang).
    geaendert = True
    while geaendert:
        geaendert = False
        for nid, node in workflow.items():
            if nid in tot:
                continue
            refs = _node_refs(node)
            if refs and all(ziel in tot for _key, ziel in refs):
                tot.add(nid)
                geaendert = True

    # 3. Tote Verdrahtungen aus den Ueberlebenden entfernen. image2/image3 sind
    #    an TextEncodeQwenImageEditPlus optional -- fehlen sie, ist das gueltig.
    for nid, node in workflow.items():
        if nid in tot:
            continue
        for key, ziel in _node_refs(node):
            if ziel in tot:
                del node["inputs"][key]

    for nid in tot:
        del workflow[nid]
    return workflow
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS — auch die bestehenden `fill`-Tests, die weiterhin vier Argumente übergeben

- [ ] **Step 6: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/workflow_template.py \
        tools/bild-service/test_workflow_template.py \
        tools/bild-service/workflows/qwen-edit.api.json
git commit -m "feat(bild-service): Edit-Vorlage mit bis zu drei Bild-Slots"
```

---

### Task 6: Der Renderpfad `render_edit`

**Files:**
- Modify: `tools/bild-service/job_state.py`
- Modify: `tools/bild-service/bild_service.py`
- Test: `tools/bild-service/test_job_state.py`
- Test: `tools/bild-service/test_bild_service.py`

**Interfaces:**
- Consumes: `sources.pick_source_images` (Task 2), `api.list_attachments` / `api.fetch_attachment` (Task 3), `comfy_client.upload_image` (Task 4), `wt.set_images` (Task 5), `config.EDIT_MODELS` (Task 1)
- Produces:
  - `job_state.add(issue_id, prompt_id, company_id, now, seed=None, modell=None, sources=None)` — `sources` ist die Liste der auf dem Knoten liegenden Namen
  - `bild_service.render_edit(company, issue, brief, now)`
  - `bild_service.upload_sources(issue_id)` → `(names, error)` — lädt die Anhänge und legt sie auf dem Knoten ab

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `test_job_state.py` anhängen:

```python
def test_add_merkt_sich_die_quellbilder(tmp_path):
    job_state.STATE_FILE = str(tmp_path / "s.json")
    job_state.add("i1", "p1", "c1", now=1.0, sources=["a.png", "b.png"])
    assert job_state.get("i1")["sources"] == ["a.png", "b.png"]


def test_add_ohne_quellbilder_bleibt_leer(tmp_path):
    job_state.STATE_FILE = str(tmp_path / "s.json")
    job_state.add("i1", "p1", "c1", now=1.0)
    assert job_state.get("i1")["sources"] == []
```

An `test_bild_service.py` anhängen:

```python
EDIT_BRIEF = {"error": None, "prompt": "entferne die Person", "modell": "qwenedit",
              "size": "1024x1024", "width": 1024, "height": 1024,
              "openai_size": "1024x1024", "quality": "medium",
              "background": "opaque", "seed": 42, "format_ignored": False}


def _att(id_, created, ctype="image/png", size=1000):
    return {"id": id_, "createdAt": created, "contentType": ctype,
            "byteSize": size, "originalFilename": id_ + ".png"}


def test_edit_laedt_bilder_hoch_und_merkt_sie_sich(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att("zwei", "2026-08-04T11:00:00.000Z"),
                                     _att("eins", "2026-08-04T10:00:00.000Z")])
    monkeypatch.setattr(bild_service.api, "fetch_attachment", lambda aid: b"BILD")
    hochgeladen = []

    def fake_upload(name, content):
        hochgeladen.append(name)
        return "knoten-" + name

    monkeypatch.setattr(comfy_client, "upload_image", fake_upload)
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-9")

    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)

    # aeltester Anhang zuerst -- das ist 'Bild 1'
    assert hochgeladen == ["eins.png", "zwei.png"]
    job = job_state.get("issue-1")
    assert job["prompt_id"] == "prompt-9"
    assert job["sources"] == ["knoten-eins.png", "knoten-zwei.png"]
    assert job["modell"] == "qwenedit"


def test_edit_ohne_anhang_bricht_ab(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments", lambda iid: [])
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)
    assert api.status["issue-1"] == "cancelled"
    assert "Bildanhang" in api.comments[0][1]
    assert job_state.get("issue-1") is None


def test_edit_mit_vier_anhaengen_bricht_ab(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att(str(n), "2026-08-04T0%d:00:00.000Z" % n)
                                     for n in range(1, 5)])
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)
    assert api.status["issue-1"] == "cancelled"


def test_edit_meldet_ignoriertes_format(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att("a", "2026-08-04T10:00:00.000Z")])
    monkeypatch.setattr(bild_service.api, "fetch_attachment", lambda aid: b"BILD")
    monkeypatch.setattr(comfy_client, "upload_image", lambda n, c: n)
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-9")
    brief = dict(EDIT_BRIEF, format_ignored=True)
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    assert any("format" in c[1].lower() for c in api.comments)


def test_process_new_issue_leitet_qwenedit_um(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    gerufen = []
    monkeypatch.setattr(bild_service, "render_edit",
                        lambda *a, **k: gerufen.append("edit"))
    monkeypatch.setattr(bild_service, "render_local",
                        lambda *a, **k: gerufen.append("local"))
    issue = {"id": "issue-1", "description": "prompt: x\nmodell: qwenedit"}
    bild_service.process_new_issue(COMPANY, issue, now=1000.0)
    assert gerufen == ["edit"]
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_bild_service.py test_job_state.py -q`
Expected: FAIL — `AttributeError: module 'bild_service' has no attribute 'render_edit'`

- [ ] **Step 3: `job_state.add` erweitern**

```python
def add(issue_id, prompt_id, company_id, now, seed=None, modell=None, sources=None):
    # 'modell' wird mitgeschrieben, weil der Einsammler den Auftrag sonst
    # nicht mehr zuordnen kann: Timeout und Wiederholversuch haengen am
    # Modell, der Brief kann bis dahin aber schon veraendert worden sein.
    # 'sources' sind die auf dem Knoten liegenden Quellbilder. Sie MUESSEN
    # hier stehen: der Dienst haengt sein eigenes Ergebnis an dasselbe Issue,
    # ein Wiederholversuch wuerde die Anhangsliste sonst erneut lesen und ab
    # dem zweiten Versuch das eigene Ergebnis weiterbearbeiten.
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    jobs[issue_id] = {"prompt_id": prompt_id, "company_id": company_id,
                      "submitted_at": now, "attempts": 1, "seed": seed,
                      "modell": modell, "sources": list(sources or [])}
    _save(st)
```

- [ ] **Step 4: `bild_service.py` erweitern**

Import oben ergänzen:

```python
import sources as src
```

`FORMAT_HINT` um die neue Zeile erweitern:

```python
FORMAT_HINT = ("Format:\n"
               "prompt: <Beschreibung>\n"
               "modell: qwen | qwen360 | qwenedit | openai\n"
               "format: 1024x1024   (bei qwen360: 2048x1024; bei qwenedit: entfällt)\n"
               "seed: 42\n"
               "\n"
               "modell: qwen360 erzeugt ein 360-Grad-Panorama in "
               "equirektangularer Projektion (2:1). Das Auslösewort steht "
               "bereits in der Vorlage — der Prompt beschreibt nur die Szene.\n"
               "modell: qwenedit bearbeitet ein bis drei Bilder, die als "
               "Anhang am Issue hängen; im Prompt heißen sie Bild 1, Bild 2, Bild 3.")
```

Nach `render_local` einfügen:

```python
def upload_sources(issue_id):
    """Quellbilder des Issues auf den Knoten legen.

    -> (names, error). names sind die vom Knoten vergebenen Dateinamen in der
    Reihenfolge 'Bild 1..3'. Bei error ist nichts abzuschicken.
    """
    bilder, fehler = src.pick_source_images(api.list_attachments(issue_id))
    if fehler:
        return [], fehler
    namen = []
    for att in bilder:
        daten = api.fetch_attachment(att["id"])
        namen.append(comfy_client.upload_image(
            att.get("originalFilename") or (att["id"] + ".png"), daten))
    return namen, None


def render_edit(company, issue, brief, now):
    iid = issue["id"]
    if len(job_state.all()) >= config.MAX_INFLIGHT_JOBS:
        if not job_state.has_queue_notice(iid):
            api.add_comment(iid, "⏳ Warteschlange voll (max. %d gleichzeitige lokale Renders). "
                                 "Auftrag wird gerendert, sobald ein Platz frei wird."
                                 % config.MAX_INFLIGHT_JOBS)
            job_state.mark_queue_notice(iid)
        return
    if cost_state.remaining_local_today(_today()) <= 0:
        api.add_comment(iid, "⚠️ Tageslimit (%d lokale Bilder) erreicht. "
                             "Morgen erneut versuchen." % config.DAILY_LOCAL_LIMIT)
        api.patch_status(iid, "cancelled")
        return
    if brief["format_ignored"]:
        api.add_comment(iid, "ℹ️ Das angegebene 'format' wird bei modell: qwenedit "
                             "ignoriert — die Ausgabegröße folgt dem ersten Quellbild.")
    try:
        namen, fehler = upload_sources(iid)
    except comfy_client.ComfyError:
        return          # Knoten weg: Auftrag bleibt liegen, naechster Zyklus versucht erneut
    if fehler:
        api.add_comment(iid, "⚠️ Bild nicht erzeugt: %s" % fehler)
        api.patch_status(iid, "cancelled")
        return
    seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
    workflow = wt.set_images(
        wt.fill(wt.load_raw(_workflow_name(brief["modell"])), brief["prompt"], seed),
        namen)
    try:
        prompt_id = comfy_client.submit(workflow)
    except comfy_client.ComfyError:
        return
    job_state.add(iid, prompt_id, company["id"], now, seed=seed,
                  modell=brief["modell"], sources=namen)
    job_state.clear_queue_notice(iid)
    cost_state.record_local(_today())
```

In `process_new_issue` die Verzweigung erweitern:

```python
    if brief["modell"] == "openai":
        render_openai(company, issue, brief)
    elif brief["modell"] in config.EDIT_MODELS:
        render_edit(company, issue, brief, now)
    else:
        render_local(company, issue, brief, now)
```

Im `done`-Zweig von `collect_one` das Label ergänzen:

```python
        modell = job.get("modell")
        if modell == "qwen360":
            label = "Qwen-Image 2512 + 360-LoRA, equirektangular"
        elif modell == "qwenedit":
            label = "Qwen-Image-Edit 2511, %d Quellbild(er)" % len(job.get("sources") or [])
        else:
            label = "Qwen-Image 2512"
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS

- [ ] **Step 6: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/bild_service.py tools/bild-service/job_state.py \
        tools/bild-service/test_bild_service.py tools/bild-service/test_job_state.py
git commit -m "feat(bild-service): Renderpfad fuer Bild-zu-Bild"
```

---

### Task 7: Der Wiederholversuch darf sich nicht selbst bearbeiten

**Files:**
- Modify: `tools/bild-service/bild_service.py:201-224` (Timeout-Zweig in `collect_one`)
- Test: `tools/bild-service/test_bild_service.py`

**Interfaces:**
- Consumes: `job_state.get(...)["sources"]` (Task 6), `wt.set_images` (Task 5)
- Produces: keine neue öffentliche Schnittstelle

**Warum das eine eigene Aufgabe ist:** Es ist der einzige Fehler in diesem Bauvorhaben, der **stillschweigend falsche Bilder** liefert statt einer Fehlermeldung. Er verdient sein eigenes Gate.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

An `test_bild_service.py` anhängen:

```python
def test_wiederholung_nutzt_die_gemerkten_quellen(monkeypatch, tmp_path):
    """Der Dienst haengt sein eigenes Ergebnis ans selbe Issue. Wuerde der
    Wiederholversuch die Anhangsliste neu lesen, bearbeitete er ab dem
    zweiten Versuch sein eigenes Bild -- still und ohne Fehlermeldung."""
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0,
                  seed=42, modell="qwenedit", sources=["quelle.png"])
    monkeypatch.setattr(bild_service.api, "get_issue",
                        lambda iid: {"description": "prompt: x\nmodell: qwenedit"})
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: pytest.fail("Anhänge dürfen NICHT neu gelesen werden"))
    monkeypatch.setattr(comfy_client, "upload_image",
                        lambda n, c: pytest.fail("nichts darf neu hochgeladen werden"))
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    gesendet = {}

    def fake_submit(wf):
        gesendet["wf"] = wf
        return "prompt-2"

    monkeypatch.setattr(comfy_client, "submit", fake_submit)

    ergebnis = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=700.0)

    assert ergebnis == "timeout"
    assert job_state.get("issue-1")["prompt_id"] == "prompt-2"
    assert gesendet["wf"]["20"]["inputs"]["image"] == "quelle.png"
    assert job_state.get("issue-1")["sources"] == ["quelle.png"]


def test_wiederholung_ohne_quellen_bleibt_der_alte_weg(monkeypatch, tmp_path):
    """Normale qwen-Auftraege haben keine sources und muessen weiterhin
    ueber Breite/Hoehe aus dem Brief neu gebaut werden."""
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0, seed=7, modell="qwen")
    monkeypatch.setattr(bild_service.api, "get_issue",
                        lambda iid: {"description": "prompt: Hirsch\nmodell: qwen"})
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    gesendet = {}
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: (gesendet.update(wf=wf), "prompt-2")[1])
    ergebnis = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=400.0)
    assert ergebnis == "timeout"
    assert gesendet["wf"]["6"]["inputs"]["text"] == "Hirsch"
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest test_bild_service.py -k wiederholung -q`
Expected: FAIL — `Failed: Anhänge dürfen NICHT neu gelesen werden`

- [ ] **Step 3: Den Timeout-Zweig anpassen**

In `collect_one`, im Block `if int(job.get("attempts", 1)) < 2:`, den Vorlagenaufbau ersetzen:

```python
            seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
            raw = wt.load_raw(_workflow_name(brief["modell"]))
            quellen = job.get("sources") or []
            if quellen:
                # Bewusst die GEMERKTEN Quellen, nicht die Anhangsliste: das
                # Ergebnis-PNG des ersten Versuchs haengt inzwischen selbst am
                # Issue und wuerde sonst zum Quellbild.
                workflow = wt.set_images(wt.fill(raw, brief["prompt"], seed), quellen)
            else:
                workflow = wt.fill(raw, brief["prompt"], seed,
                                   brief["width"], brief["height"])
            try:
                new_id = comfy_client.submit(workflow)
            except comfy_client.ComfyError:
                return "running"
            job_state.bump_attempt(issue_id, new_id, now, seed=seed)
            return "timeout"
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q`
Expected: PASS

- [ ] **Step 5: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add tools/bild-service/bild_service.py tools/bild-service/test_bild_service.py
git commit -m "fix(bild-service): Wiederholversuch nutzt die gemerkten Quellbilder"
```

---

### Task 8: Ausrollen und Rauchtest am Renderknoten

**Files:** kein Code — dieser Schritt bringt den Stand live und prüft die Wirklichkeit.

**Interfaces:**
- Consumes: alles aus Task 1–7
- Produces: gemessene Zahlen für die Doku in Task 9

**Voraussetzung:** ComfyUI auf `192.168.2.40:8189` erreichbar:
`curl -s -o /dev/null -w '%{http_code}\n' http://192.168.2.40:8189/system_stats` → `200`

- [ ] **Step 0: Deployen — vorher passiert am laufenden Dienst nichts**

```bash
cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -m pytest -q   # letztes Mal grün?
"$PAPERCLIP_REPO/tools/bild-service/deploy.sh"
diff -rq "$PAPERCLIP_REPO/tools/bild-service" ~/.paperclip/scripts/bild-service \
  | grep -v "__pycache__\|.pytest_cache"
```

Expected: `deploy.sh` listet die Dateien; der `diff` meldet als Unterschied nur
noch `deploy.sh` und `node/`. Der launchd-Dienst greift den neuen Stand im
nächsten Zyklus (≤ 60 s) — bis dahin läuft noch der alte.

- [ ] **Step 1: Ein Bild, einfache Anweisung**

Ein Wegwerf-Issue in WHITESTAG anlegen, Label `bild` (`9433325a-fa6e-43c2-bb09-b077a01843de`), ein Foto anhängen, Beschreibung:

```
prompt: entferne die Person im Hintergrund
modell: qwenedit
seed: 42
```

Warten (≤ 60 s Poll + Render), dann das Ergebnis-PNG ansehen. **Prüfen:** Ist das Motiv erhalten und nur die Anweisung ausgeführt? Gibt es großflächige Patch-Artefakte?

**Wenn Artefakte auftreten:** Das ist die aus der 360-Arbeit bekannte Falle — die LoRA-Quantisierung passt nicht zum Basismodell. Gegenprobe: in `tools/bild-service/workflows/qwen-edit.api.json` (**im Repo**, dann `deploy.sh`) die Node `"4"` (LoraLoaderModelOnly) entfernen, die Node `"5"` auf `["1", 0]` umhängen und in Node `"9"` `steps` auf `20` sowie `cfg` auf `3.5` setzen. Dann Schritt 1 wiederholen und beide Ergebnisse vergleichen. Die bessere Variante gewinnt und wird committet.

- [ ] **Step 2: Dauer notieren**

Der Abschlusskommentar am Issue nennt die Dauer. Notieren — sie geht in Task 9.

- [ ] **Step 3: Zwei Bilder kombinieren**

Zweites Wegwerf-Issue, zwei Bilder anhängen (erst das Produkt, dann die Szene), Beschreibung:

```
prompt: stelle das Produkt aus Bild 1 auf den Tisch in Bild 2
modell: qwenedit
```

**Prüfen:** Trifft „Bild 1" tatsächlich das zuerst angehängte Bild? Das ist die Gegenprobe zur `desc(createdAt)`-Umkehrung aus Task 2 gegen die Wirklichkeit.

- [ ] **Step 4: Gegenprobe — der normale Bildpfad ist unverändert**

```bash
cd "$PAPERCLIP_REPO/tools/bild-service" && python3 -c "
import comfy_client as cc, workflow_template as wt, time, hashlib
wf = wt.fill(wt.load_raw('qwen-image'), 'Ein weisser Hirsch im Nebel', 4242, 1024, 1024)
pid = cc.submit(wf)
while True:
    st, payload = cc.poll(pid)
    if st != 'running': break
    time.sleep(3)
print(st, hashlib.sha256(cc.fetch_image(payload[0])).hexdigest())
"
```

Denselben Befehl **vor** und **nach** einem `qwenedit`-Lauf ausführen. Die beiden SHA-256-Werte müssen **identisch** sein. Weichen sie ab, verändert der Edit-Pfad die zwischengespeicherten Modelle des normalen Pfades — dann wie beim 360-Workflow eigene Modellkopien einziehen, bevor irgendetwas scharf geht.

- [ ] **Step 5: Fehlerfall von Hand**

Drittes Wegwerf-Issue, `modell: qwenedit`, **ohne** Anhang. Erwartung: nach spätestens 60 s `cancelled` plus Kommentar „Kein Bildanhang am Issue…".

---

### Task 9: Doku und Ausrollen an die Agenten

**Files:**
- Modify: `~/.paperclip/scripts/agents-instructions/_common.md`
- Modify: `<repo>/docs/superpowers/ANLEITUNG-bild-video-auftraege.md`
- Modify: `<repo>/docs/superpowers/specs/2026-08-04-bild-zu-bild-design.md` (Status)

`<repo>` = `/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip`

**Interfaces:**
- Consumes: die gemessenen Zahlen aus Task 8
- Produces: keine Code-Schnittstelle

- [ ] **Step 1: `_common.md` erweitern**

Im Block „Bild/Grafik bestellen", nach dem Abschnitt „### 360-Grad-Panoramen", einfügen:

```markdown
### Ein vorhandenes Bild bearbeiten

Soll ein **vorhandenes Bild** verändert werden — Objekt entfernen, Hintergrund
tauschen, umstilisieren, zwei Bilder kombinieren —, setze `modell: qwenedit`
und hänge die Quellbilder **an den Subtask**, den du anlegst (nicht an dein
eigenes Issue).

```
prompt: entferne die Person im Hintergrund
modell: qwenedit
```

Dabei gilt:
- **Ein bis drei Bilder.** Im Prompt heißen sie in der Reihenfolge, in der du
  sie angehängt hast, `Bild 1`, `Bild 2`, `Bild 3`. Bei nur einem Anhang
  brauchst du keinen Verweis.
- **Kein `format:`.** Die Ausgabegröße folgt dem ersten Quellbild.
- **Ohne Anhang bricht der Auftrag ab** — der Dienst kann nicht raten, was du
  bearbeiten willst.
```

- [ ] **Step 2: Instruktionen ausrollen**

```bash
cd ~/.paperclip/scripts/agents-instructions
export PCP_API=http://localhost:3100
export PCP_CID=9cebf3cf-efe8-4597-a400-f06488900a87
export PCP_TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")
python3 build-agents-md.py --backup
python3 build-agents-md.py --dry-run
python3 build-agents-md.py --apply
python3 build-agents-md.py --verify
```

Expected: `--dry-run` zeigt bei **allen 26** Agenten mehr Zeilen (der Block steht in `_common.md`, nicht in einer Rolle); `--verify` endet mit `VERIFY OK`.

**Achtung:** `--backup` und `--apply` sind getrennte Aufrufe. `--backup --apply` in einem Aufruf führt **nur** das Backup aus — die Modi werden der Reihe nach geprüft und der erste gewinnt.

- [ ] **Step 3: Die Anleitung nachziehen**

In `docs/superpowers/ANLEITUNG-bild-video-auftraege.md`:

1. In der Tabelle in Abschnitt 1 die Zeile „Bild → Bild" von „nein" auf **ja** setzen, mit `modell: qwenedit` und der in Task 8 gemessenen Dauer.
2. In Abschnitt 6 den Absatz „Bild → Bild (Variante, Retusche, Umstilisierung)" streichen und stattdessen einen neuen Abschnitt „4a. Bild → Bild" nach dem 360-Abschnitt einfügen: Musterauftrag, die Ein-bis-drei-Bilder-Regel, „Bild 1 = zuerst angehängt", kein `format:`, Fehlerfälle.
3. In der Tabelle in Abschnitt 7 die Zeitgrenze für `qwenedit` (600 s) ergänzen.

- [ ] **Step 4: `.docx` neu bauen**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip"
pandoc -f markdown -t docx docs/superpowers/ANLEITUNG-bild-video-auftraege.md \
  -o "Dokumente/WHITESTAG.AI/Anleitung WHITESTAG Bild-Video-Auftraege V2.docx"
```

- [ ] **Step 5: Spec auf „umgesetzt" setzen**

In `docs/superpowers/specs/2026-08-04-bild-zu-bild-design.md` die Kopfzeile
`**Status:** entworfen, noch nicht gebaut` ersetzen durch
`**Status:** umgesetzt am 2026-08-04` und die gemessenen Zahlen aus Task 8
im Abschnitt „Rauchtest am Knoten" nachtragen.

- [ ] **Step 6: Committen**

```bash
cd "$PAPERCLIP_REPO"
git add docs/superpowers/ANLEITUNG-bild-video-auftraege.md \
        docs/superpowers/specs/2026-08-04-bild-zu-bild-design.md
git commit -m "$(cat <<'EOF'
docs(bild-service): Bild-zu-Bild in Anleitung und Spec nachziehen

Bild2Bild ist bestellbar (modell: qwenedit, ein bis drei Anhaenge). Spec auf
umgesetzt gesetzt, gemessene Zahlen aus dem Rauchtest nachgetragen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

Der Code selbst ist bereits committet (Task 1–7). `_common.md` liegt unter
`~/.paperclip/scripts/agents-instructions/` und ist **nicht** versioniert —
die Sicherung dort macht `build-agents-md.py --backup`.

- [ ] **Step 7: Sichtprüfung im Betrieb**

```bash
tail -20 ~/.paperclip/instances/default/state/bild-service.out.log
tail -20 ~/.paperclip/instances/default/state/bild-service.err.log
```

Expected: keine Traceback-Zeilen aus den letzten Zyklen.

---

## Selbstprüfung des Plans

**Spec-Abdeckung** — jede Anforderung der Spec hat eine Aufgabe:

| Spec-Abschnitt | Aufgabe |
|---|---|
| Bestellformat `qwenedit`, `format:` ignoriert | Task 1 |
| Reihenfolge = Anhang-Reihenfolge, `desc(createdAt)` umkehren | Task 2 |
| Fehlerfälle (kein Bild, >3, >20 MB, Nicht-Bild) | Task 2 (Logik), Task 6 (Meldung + `cancelled`) |
| Prüfung an `contentType`/`byteSize` ohne Download | Task 2 |
| Transport `POST /upload/image` | Task 4 |
| Vorlage, eine für 1–3 Bilder, optionale Slots | Task 5 |
| Ausgabegröße folgt Bild 1 (`VAEEncode`) | Task 5 |
| `render_edit`, Verdrahtung, `job_state.sources` | Task 6 |
| Reentrance-Fallstrick beim Wiederholversuch | Task 7 |
| Keine eigenen Modellkopien — belegt statt angenommen | Task 8, Step 4 |
| LoRA-Quantisierung prüfen, Fallback 20 Schritte/cfg 3.5 | Task 8, Step 1 |
| Rauchtest 1 Bild / 2 Bilder / Gegenprobe | Task 8 |
| Ausrollen Repo → Live (`deploy.sh`) | Task 8, Step 0 |
| `_common.md`, Generator-Rollout, Anleitung | Task 9 |
| Tageszähler und Inflight-Grenze gelten mit | Task 6 (`render_edit` prüft beide) |

**Platzhalter:** keine. Jeder Code-Schritt enthält den einzusetzenden Code.

**Typkonsistenz geprüft:**
- `pick_source_images` liefert überall `(images, error)` — Task 2 definiert, Task 6 nutzt.
- `upload_image(filename, content)` → `str`: Task 4 definiert, Task 6 nutzt in dieser Reihenfolge.
- `set_images(workflow, names)` → Workflow-Dict: Task 5 definiert, Task 6 und Task 7 nutzen.
- `job_state.add(..., sources=None)`: Task 6 definiert, Task 7 liest `job["sources"]`.
- `brief["format_ignored"]`: Task 1 definiert, Task 6 liest.
- `config.EDIT_MODELS`: Task 1 definiert, Task 6 liest.
