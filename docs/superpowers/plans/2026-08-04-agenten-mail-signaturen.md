# Agenten-Mail-Signaturen — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHE SUB-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Aufgabe für Aufgabe umzusetzen. Die Schritte nutzen Checkbox-Syntax (`- [ ]`) zur Nachverfolgung.

**Ziel:** Jede Mail, die ein Paperclip-Absender an Walter schickt, trägt eine Signatur im Stil der aktuellen WHITESTAG-Signaturen; der Geschäftsbereich ist pro Mail wählbar. Gleichzeitig wird der Bereich sorbART stillgelegt.

**Architektur:** Ein Generator erzeugt aus Bereichsdaten, einer Vorlage und aufbereiteten Logos je Bereich eine fertige Signatur-HTML-Datei mit dem Platzhalter `{{ABSENDERBLOCK}}`. Zur Laufzeit setzt der SMTP-Relay den absenderspezifischen `i.A.`-Block ein und hängt das Logo als Inline-CID-Anhang an. Luna rendert dieselben Bausteine client-seitig weiter, weil sie die Vorschau vor der Freigabe braucht.

**Tech-Stack:** Python 3.9 (`/usr/bin/python3`), pytest 8.4.2, Pillow 11.3, pngquant, Node 22 (`node --test`), n8n 2.25 mit SQLite-Backend.

**Spec:** [2026-08-04-agenten-mail-signaturen-design.md](../specs/2026-08-04-agenten-mail-signaturen-design.md)

## Global Constraints

- **Python-Zielversion ist 3.9.6** (`/usr/bin/python3`) — der Sekretärin-Watcher läuft per LaunchAgent genau damit. Keine `X | None`-Syntax; in jeder neuen Datei `from __future__ import annotations` als erste Anweisung.
- **Quelle ist das Repo, nicht der Live-Pfad.** Aller neue Code wird unter `tools/signatur/` in diesem Repo geschrieben und committet. Der Live-Pfad `~/.paperclip/scripts/signatur/` entsteht ausschliesslich durch `tools/signatur/deploy.sh` — nie von Hand editieren. Das ist die Hauskonvention (siehe `tools/bild-service/deploy.sh`) und der Grund dafür ist launchd: es kann SynologyDrive nicht lesen, deshalb muss zur Laufzeit eine Kopie unter `~/.paperclip` liegen.
- **Ausnahme:** `~/.paperclip/scripts/agents-instructions/` (Aufgabe 6) liegt nicht im Repo. Dort ist `build-agents-md.py --backup` das Sicherungsnetz, nicht git.
- **Quelle der Gestaltung** ist der Ordner `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip/Signatures/`. Nur lesen, nie verändern.
- **Der Signaturpfad darf den Mailversand nie blockieren.** Jeder Fehler beim Signieren führt dazu, dass die Mail **ohne** Signatur rausgeht plus eine Logzeile. Über denselben Relay laufen die Wächter-Alarme.
- **Die sechs Bereichsschlüssel** lauten exakt: `ai`, `film`, `tv`, `academy`, `app`, `de`. **sorbART ist kein Bereich mehr** — siehe Aufgabe 3 und 6.
- **Der Platzhalter** heißt wörtlich `{{ABSENDERBLOCK}}` — genau ein Vorkommen pro Bereichsdatei.
- **Anzeigebreite aller Logos: 125 px** bei 250 px Quellbreite (Faktor 2 für Retina).
- **Größenbudget je Logo: 60 KB.** Gemessene Werte der Referenzumsetzung: 24–38 KB.
- **Feste Werte, in allen sechs Bereichen gleich** — gehören in die Vorlage, nicht in die Datendatei: Grußformel `Beste Grüße`, Funktionsbezeichnung `Inhaber`, Adresse `Cottbus: Parzellenstr. 28 – 03050 Cottbus`, `T: 0355-49943777`, `M: 0177-4511000`, Disclaimer beginnend mit `WHITESTAG übernimmt keine Haftung`.
- **n8n-Änderungen:** Version hochzählen, nie die laufende Fassung überschreiben. Publizieren ausschließlich per deactivate → activate, sonst führt n8n weiter die alte `activeVersionId` aus.

## Dateiübersicht

Alle Pfade relativ zur Repo-Wurzel.

| Datei | Verantwortung |
|---|---|
| `tools/signatur/logos_bauen.py` | Einmal-Werkzeug: Originallogos → 250 px, farbreduziert |
| `tools/signatur/logos/<key>.png` | Erzeugte Logos (6 Stück) — **committet**, weil `Signatures/` nicht im Repo liegt |
| `tools/signatur/bereiche.json` | Bereichsdaten — die einzige Stelle für Bereichszeile, Adresse, Domain |
| `tools/signatur/vorlage.html` | HTML-Gerüst einer Signatur mit Feld-Platzhaltern |
| `tools/signatur/signatur_build.py` | Generator: Bereichsdaten + Vorlage + Logo → `bereich-<key>.html` |
| `tools/signatur/bereich-<key>.html` | Erzeugt, **nicht committet** (gitignored) — entsteht beim Deploy neu |
| `tools/signatur/signatur.py` | Laufzeit-Bibliothek (Python): Absenderblock bilden, komponieren, Logo→CID |
| `tools/signatur/relay_signatur.js` | Dieselbe Laufzeitlogik für den n8n-Code-Node |
| `tools/signatur/patch_relay.py` | Einmal-Werkzeug: Relay-Workflow klonen, Node einhängen, publizieren |
| `tools/signatur/deploy.sh` | Kopiert nach `~/.paperclip/scripts/signatur/` und erzeugt dort die Bausteine |
| `tools/signatur/test_*.py`, `test_*.mjs` | Tests |
| `tools/sekretaerin-mail-watcher/luna_mail_render.py` | Geändert: nutzt `signatur.py`, SORBART entfällt |
| `tools/sekretaerin-mail-watcher/test_luna_mail_render.py` | **Ersetzt** — die vorhandene Fassung patcht `r.SIGDIR`, das entfällt |
| `tools/sekretaerin-mail-watcher/SMTP-Relay-V17.export.json` | Erzeugt in Aufgabe 5, neben dem vorhandenen V16-Export |

---

### Task 1: Logos aufbereiten

Die Originale sind 261×261 px und 105–139 KB. Das Herunterrechnen allein bringt wenig — der Hebel ist die Farbreduktion per pngquant. Gemessen: 24–38 KB bei erhaltener Qualität.

**Files:**
- Create: `tools/signatur/logos_bauen.py`
- Create: `tools/signatur/logos/` (Ausgabe, 6 PNG)
- Test: `tools/signatur/test_logos.py`

**Interfaces:**
- Consumes: nichts
- Produces: `logos/<key>.png` für `ai`, `film`, `tv`, `academy`, `app`, `de`. Alle 250 px breit, ≤ 60 KB.

- [ ] **Schritt 1: Verzeichnis anlegen**

```bash
mkdir -p tools/signatur/logos
cd tools/signatur
```

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

Datei `test_logos.py`:

```python
from __future__ import annotations

import os

from PIL import Image

LOGODIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logos")
KEYS = ["ai", "film", "tv", "academy", "app", "de"]
MAX_BYTES = 60 * 1024


def test_alle_sechs_logos_vorhanden():
    fehlend = [k for k in KEYS if not os.path.exists(os.path.join(LOGODIR, k + ".png"))]
    assert fehlend == []


def test_logos_sind_250px_breit():
    for k in KEYS:
        with Image.open(os.path.join(LOGODIR, k + ".png")) as im:
            assert im.width == 250, k


def test_logos_unter_budget():
    zu_gross = [
        k for k in KEYS
        if os.path.getsize(os.path.join(LOGODIR, k + ".png")) > MAX_BYTES
    ]
    assert zu_gross == []


def test_logos_haben_transparenz():
    # Die Signaturen stehen auf weissem Mailgrund; ein verlorener Alphakanal
    # faellt erst beim Empfaenger auf.
    for k in KEYS:
        with Image.open(os.path.join(LOGODIR, k + ".png")) as im:
            assert im.mode in ("RGBA", "P"), k
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd tools/signatur && /usr/bin/python3 -m pytest test_logos.py -v`
Erwartet: `test_alle_sechs_logos_vorhanden` schlägt fehl, weil alle sechs Dateien fehlen.

- [ ] **Schritt 4: Das Werkzeug schreiben**

Datei `logos_bauen.py`:

```python
#!/usr/bin/env python3
"""Bereitet die Signaturlogos auf: 250 px breit, farbreduziert, transparent.

Einmal-Werkzeug. Erneut laufen lassen, wenn im Signatures-Ordner ein Logo
ausgetauscht wurde. Danach `signatur_build.py` aufrufen, damit die
Bereichsdateien das neue Logo aufnehmen.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

from PIL import Image

QUELLE = os.path.expanduser(
    "~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip/Signatures"
)
ZIEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logos")

# Bereichsschluessel -> Ordnername im Signatures-Verzeichnis.
# "WHIETSTAG FILM" ist im Original so geschrieben — kein Tippfehler hier.
ORDNER = {
    "ai": "WHITESTAG AI-Dateien",
    "film": "WHIETSTAG FILM-Dateien",
    "tv": "WHITESTAG TV-Dateien",
    "academy": "WHITESTAG ACADEMY-Dateien",
    "app": "WHITESTAG APP-Dateien",
    "de": "WHITESTAG DE-Dateien",
}

BREITE = 250


def baue(key: str, ordner: str) -> None:
    quelle = os.path.join(QUELLE, ordner, "image001.png")
    if not os.path.exists(quelle):
        raise SystemExit("Quelllogo fehlt: " + quelle)

    with Image.open(quelle) as im:
        im = im.convert("RGBA")
        hoehe = max(1, round(im.height * BREITE / im.width))
        im = im.resize((BREITE, hoehe), Image.LANCZOS)
        fd, roh = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        im.save(roh, optimize=True)

    ziel = os.path.join(ZIEL, key + ".png")
    try:
        subprocess.run(
            ["pngquant", "--quality=65-90", "--speed=1", "--force",
             "--output", ziel, roh],
            check=True,
        )
    finally:
        os.unlink(roh)

    print("%-8s %6d Bytes" % (key, os.path.getsize(ziel)))


def main() -> int:
    os.makedirs(ZIEL, exist_ok=True)
    for key, ordner in ORDNER.items():
        baue(key, ordner)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Schritt 5: Werkzeug ausführen**

Ausführen: `cd tools/signatur && /usr/bin/python3 logos_bauen.py`
Erwartet: sechs Zeilen, jede unter 60000 Bytes.

- [ ] **Schritt 6: Tests laufen lassen, grün bestätigen**

Ausführen: `/usr/bin/python3 -m pytest test_logos.py -v`
Erwartet: 4 passed.

- [ ] **Schritt 7: Sichtprüfung**

Ausführen: `open tools/signatur/logos/`
Erwartet: Bei allen sechs ist das Geweih des Hirschs sauber und der Partikelverlauf frei von sichtbaren Farbstufen. Wenn nicht, `--quality=80-95` in `logos_bauen.py` setzen und Schritt 5–7 wiederholen.

- [ ] **Schritt 8: Committen**

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/signatur/logos_bauen.py tools/signatur/test_logos.py tools/signatur/logos/
git commit -m "feat(signatur): Logos der sechs Bereiche aufbereitet"
```

Die Logos werden committet, obwohl sie abgeleitet sind: Der Quellordner
`Signatures/` liegt nicht im Repo, ohne sie liesse sich der Stand nicht
reproduzieren.

---

### Task 2: Bereichsdaten, Vorlage und Generator

Alle sechs Bereiche teilen Grußformel, Funktionsbezeichnung, Anschrift, Rufnummern und Disclaimer. In den Bereichsdaten steht deshalb nur, was sich tatsächlich unterscheidet: Bereichszeile, Mailadresse, Web-Adresse und Alternativtext des Logos.

**Files:**
- Create: `tools/signatur/bereiche.json`
- Create: `tools/signatur/vorlage.html`
- Create: `tools/signatur/signatur_build.py`
- Test: `tools/signatur/test_signatur_build.py`

**Interfaces:**
- Consumes: `logos/<key>.png` aus Aufgabe 1
- Produces: `bereich-<key>.html` für alle sechs Schlüssel. Jede Datei enthält genau ein `{{ABSENDERBLOCK}}` und genau ein `<img src="data:image/png;base64,…">`.
- Produces: `signatur_build.baue(key: str) -> str` (liefert das HTML) und `signatur_build.main(zielverzeichnis: str = None) -> int` (schreibt alle sechs Dateien; ohne Argument nach `HIER`).

- [ ] **Schritt 1: Bereichsdaten anlegen**

Datei `bereiche.json`. Werte aus den Originalen in `Signatures/`. `firma` bleibt leer, wo das Original keine Bereichszeile trägt — bei ACADEMY, APP und DE steht der Claim im Logo.

```json
{
  "ai": {
    "firma": "WHITESTAG – Artificial Intelligence",
    "mail": "ws@whitestag.ai",
    "web": "www.whitestag.ai",
    "url": "https://www.whitestag.ai/",
    "logo_alt": "WHITESTAG – Artificial Intelligence"
  },
  "film": {
    "firma": "WHITESTAG – VR Filmproduktion",
    "mail": "ws@whitestag.film",
    "web": "www.whitestag.film",
    "url": "https://www.whitestag.film/",
    "logo_alt": "WHITESTAG – VR Filmproduktion"
  },
  "tv": {
    "firma": "WHITESTAG – Television & Broadcast",
    "mail": "ws@whitestag.tv",
    "web": "www.whitestag.tv",
    "url": "https://www.whitestag.tv/",
    "logo_alt": "WHITESTAG.TV – Fernsehen & Broadcast"
  },
  "academy": {
    "firma": "",
    "mail": "ws@whitestag.academy",
    "web": "www.whitestag.academy",
    "url": "https://www.whitestag.academy/",
    "logo_alt": "WHITESTAG.ACADEMY – KI verstehen. Vorsprung sichern."
  },
  "app": {
    "firma": "",
    "mail": "ws@whitestag.app",
    "web": "www.whitestag.app",
    "url": "https://www.whitestag.app/",
    "logo_alt": "WHITESTAG.APP – Digitale Erlebniswelten"
  },
  "de": {
    "firma": "",
    "mail": "ws@whitestag.de",
    "web": "www.whitestag.de",
    "url": "https://www.whitestag.de/",
    "logo_alt": "WHITESTAG.DE"
  }
}
```

- [ ] **Schritt 2: Vorlage anlegen**

Datei `vorlage.html`. Tabellenlayout, weil Outlook Flexbox und Grid ignoriert. Die Feld-Platzhalter setzt der Generator, `{{ABSENDERBLOCK}}` bleibt bis zur Laufzeit stehen.

```html
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#222;">
 <tr><td style="padding:0 0 10px 0;">
   <div style="font-size:13px;color:#222;">Beste Grüße</div>
{{ABSENDERBLOCK}}
 </td></tr>
 <tr><td style="padding:0 0 8px 0;">
   <div style="font-size:14px;font-weight:bold;color:#111;">Walter Schönenbröcher</div>
   <div style="font-size:12px;color:#555;">Inhaber</div>
 </td></tr>
 <tr><td style="padding:0 0 8px 0;">
   <img src="data:image/png;base64,{{LOGO_B64}}" width="125" height="{{LOGO_HOEHE}}" alt="{{LOGO_ALT}}" style="display:block;border:0;outline:none;max-width:125px;height:auto;">
 </td></tr>
 <tr><td style="padding:0 0 8px 0;">
{{FIRMA_ZEILE}}
   <div style="font-size:12px;color:#333;">Cottbus: Parzellenstr. 28 – 03050 Cottbus</div>
   <div style="font-size:12px;color:#333;">E: <a href="mailto:{{MAIL}}" style="color:#0066cc;text-decoration:none;">{{MAIL}}</a></div>
   <div style="font-size:12px;color:#333;">T: 0355-49943777 &nbsp;·&nbsp; M: 0177-4511000</div>
   <div style="font-size:12px;color:#333;">W: <a href="{{URL}}" style="color:#0066cc;text-decoration:none;">{{WEB}}</a></div>
 </td></tr>
 <tr><td style="padding:8px 0 0 0;border-top:1px solid #e0e0e0;">
   <div style="font-size:10px;color:#999;line-height:1.35;">WHITESTAG übernimmt keine Haftung für den Inhalt dieser E-Mail oder für die Folgen von Maßnahmen, die auf der Grundlage der bereitgestellten Informationen ergriffen werden, es sei denn, diese Informationen werden später schriftlich bestätigt. Wenn Sie nicht der beabsichtigte Empfänger sind, werden Sie darüber informiert, dass das Weitergeben, Kopieren, Verteilen oder Ergreifen von Maßnahmen in Abhängigkeit vom Inhalt dieser Informationen strengstens untersagt ist.</div>
 </td></tr>
</table>
```

- [ ] **Schritt 3: Den fehlschlagenden Test schreiben**

Datei `test_signatur_build.py`:

```python
from __future__ import annotations

import json
import os
import re

import pytest

import signatur_build

HIER = os.path.dirname(os.path.abspath(__file__))
KEYS = ["ai", "film", "tv", "academy", "app", "de"]


@pytest.fixture(scope="module")
def gebaut():
    return {k: signatur_build.baue(k) for k in KEYS}


def test_jede_signatur_hat_genau_einen_absender_platzhalter(gebaut):
    for k, html in gebaut.items():
        assert html.count("{{ABSENDERBLOCK}}") == 1, k


def test_keine_offenen_platzhalter_uebrig(gebaut):
    for k, html in gebaut.items():
        offen = set(re.findall(r"\{\{[A-Z_]+\}\}", html)) - {"{{ABSENDERBLOCK}}"}
        assert offen == set(), (k, offen)


def test_logo_ist_base64_eingebettet(gebaut):
    for k, html in gebaut.items():
        treffer = re.findall(r'src="data:image/png;base64,([A-Za-z0-9+/=]+)"', html)
        assert len(treffer) == 1, k
        assert len(treffer[0]) > 1000, k


def test_kontaktdaten_stammen_aus_den_bereichsdaten(gebaut):
    daten = json.load(open(os.path.join(HIER, "bereiche.json"), encoding="utf-8"))
    for k, html in gebaut.items():
        assert daten[k]["mail"] in html, k
        assert daten[k]["web"] in html, k


def test_feste_bestandteile_in_allen_bereichen(gebaut):
    for k, html in gebaut.items():
        assert "Beste Grüße" in html, k
        assert "Walter Schönenbröcher" in html, k
        assert "Inhaber" in html, k
        assert "Parzellenstr. 28" in html, k
        assert "WHITESTAG übernimmt keine Haftung" in html, k


def test_bereichszeile_nur_wo_im_original_vorhanden(gebaut):
    assert "WHITESTAG – Artificial Intelligence" in gebaut["ai"]
    assert "WHITESTAG – VR Filmproduktion" in gebaut["film"]
    assert "WHITESTAG – Television &amp; Broadcast" in gebaut["tv"]
    # academy, app und de tragen ihren Claim im Logo, nicht als Textzeile
    for k in ["academy", "app", "de"]:
        assert 'font-weight:bold;color:#111;">WHITESTAG' not in gebaut[k], k


def test_kaufmaennisches_und_ist_maskiert(gebaut):
    # "Television & Broadcast" muss als &amp; im HTML stehen, sonst brechen
    # strenge Mailclients das Markup auf.
    assert "Television &amp; Broadcast" in gebaut["tv"]


def test_sorbart_ist_kein_bereich_mehr():
    daten = json.load(open(os.path.join(HIER, "bereiche.json"), encoding="utf-8"))
    assert "sorbart" not in daten
    assert set(daten) == set(KEYS)


def test_unbekannter_bereich_wirft():
    with pytest.raises(KeyError):
        signatur_build.baue("gibtsnicht")


def test_main_schreibt_alle_sechs_dateien(tmp_path):
    assert signatur_build.main(str(tmp_path)) == 0
    for k in KEYS:
        assert (tmp_path / ("bereich-%s.html" % k)).exists(), k
```

- [ ] **Schritt 4: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd tools/signatur && /usr/bin/python3 -m pytest test_signatur_build.py -v`
Erwartet: Sammelfehler `ModuleNotFoundError: No module named 'signatur_build'`.

- [ ] **Schritt 5: Den Generator schreiben**

Datei `signatur_build.py`:

```python
#!/usr/bin/env python3
"""Erzeugt aus Bereichsdaten, Vorlage und Logo je Bereich eine Signaturdatei.

Ausgabe: bereich-<key>.html mit dem Platzhalter {{ABSENDERBLOCK}}, den die
Laufzeit (signatur.py bzw. der n8n-Node) durch den absenderspezifischen
i.A.-Block ersetzt.

Nach jeder Aenderung an bereiche.json, vorlage.html oder logos/ erneut laufen
lassen.
"""
from __future__ import annotations

import base64
import html as htmllib
import json
import os
import sys

from PIL import Image

HIER = os.path.dirname(os.path.abspath(__file__))
KEYS = ["ai", "film", "tv", "academy", "app", "de"]

ANZEIGE_BREITE = 125


def _lade_bereiche():
    with open(os.path.join(HIER, "bereiche.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _firma_zeile(daten) -> str:
    """Bereichszeile — nur dort, wo das Original eine traegt."""
    if not daten["firma"]:
        return ""
    return (
        '   <div style="font-size:13px;font-weight:bold;color:#111;">%s</div>'
        % htmllib.escape(daten["firma"])
    )


def baue(key: str) -> str:
    """Liefert das fertige Signatur-HTML eines Bereichs.

    Wirft KeyError, wenn der Bereich unbekannt ist, und FileNotFoundError,
    wenn Vorlage oder Logo fehlen.
    """
    daten = _lade_bereiche()[key]

    logo_pfad = os.path.join(HIER, "logos", key + ".png")
    with open(logo_pfad, "rb") as fh:
        logo_b64 = base64.b64encode(fh.read()).decode("ascii")
    with Image.open(logo_pfad) as im:
        hoehe = int(round(im.height * ANZEIGE_BREITE / im.width))

    with open(os.path.join(HIER, "vorlage.html"), encoding="utf-8") as fh:
        vorlage = fh.read()

    ersetzungen = {
        "{{FIRMA_ZEILE}}": _firma_zeile(daten),
        "{{LOGO_B64}}": logo_b64,
        "{{LOGO_HOEHE}}": str(hoehe),
        "{{LOGO_ALT}}": htmllib.escape(daten["logo_alt"], quote=True),
        "{{MAIL}}": htmllib.escape(daten["mail"]),
        "{{WEB}}": htmllib.escape(daten["web"]),
        "{{URL}}": htmllib.escape(daten["url"], quote=True),
    }
    for platzhalter, wert in ersetzungen.items():
        vorlage = vorlage.replace(platzhalter, wert)
    return vorlage


def main(zielverzeichnis: str = None) -> int:
    ziel_dir = zielverzeichnis or HIER
    for key in KEYS:
        ziel = os.path.join(ziel_dir, "bereich-%s.html" % key)
        with open(ziel, "w", encoding="utf-8") as fh:
            fh.write(baue(key))
        print("%-8s %6d Bytes" % (key, os.path.getsize(ziel)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Schritt 6: Tests laufen lassen, grün bestätigen**

Ausführen: `/usr/bin/python3 -m pytest test_signatur_build.py -v`
Erwartet: 10 passed.

- [ ] **Schritt 7: Dateien erzeugen**

Ausführen: `/usr/bin/python3 signatur_build.py`
Erwartet: sechs Zeilen. Jede Datei liegt zwischen etwa 35 und 70 KB (Logo als base64 plus Markup).

- [ ] **Schritt 8: Sichtprüfung im Browser**

```bash
cd tools/signatur
for k in ai film tv academy app de; do
  sed "s|{{ABSENDERBLOCK}}|<div style=\"font-size:13px;color:#222;\"><strong>i.A. CTO</strong> – KI-Agent</div>|" \
    "bereich-$k.html" > "/tmp/sigvorschau-$k.html"
done
open /tmp/sigvorschau-*.html
```

Erwartet: Sechs Vorschauen, jede mit Grußformel, `i.A. CTO`, Walter, Logo, Kontaktblock und Disclaimer. Bei `academy`, `app` und `de` steht bewusst keine Bereichszeile über der Adresse.

- [ ] **Schritt 9: Deploy-Skript schreiben**

Nach dem Muster von `tools/bild-service/deploy.sh`. Es kopiert die Quellen und
lässt den Generator **am Zielort** laufen — so liegen die base64-aufgeblähten
Bausteine nirgends doppelt herum.

Datei `tools/signatur/deploy.sh`:

```bash
#!/usr/bin/env bash
# Deploy der Signaturbausteine nach ~/.paperclip/scripts/signatur/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/signatur"
DEST="$HOME/.paperclip/scripts/signatur"

mkdir -p "$DEST/logos"

# Pflichtdateien — fehlen sie, ist das ein Fehler und set -e soll greifen.
cp "$SRC"/signatur_build.py "$SRC"/logos_bauen.py "$DEST/"
cp "$SRC"/bereiche.json "$SRC"/vorlage.html "$DEST/"
cp "$SRC"/logos/*.png "$DEST/logos/"

# Optionale Dateien: entstehen erst in Aufgabe 3, 4 und 5. Fehlen ist in
# Ordnung, wird aber gemeldet — ein Deploy, das stillschweigend etwas
# auslaesst, ist genau der Drift, den dieses Skript verhindern soll.
for f in signatur.py relay_signatur.js patch_relay.py; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/"
  else
    echo "  uebersprungen (noch nicht vorhanden): $f"
  fi
done"

# Bausteine am Zielort erzeugen statt kopieren: sie sind abgeleitet und gross.
( cd "$DEST" && /usr/bin/python3 signatur_build.py )

echo "Deployt nach $DEST"
```

Ausführbar machen und laufen lassen:
```bash
chmod +x tools/signatur/deploy.sh
tools/signatur/deploy.sh
```
Erwartet: sechs Bausteinzeilen und `Deployt nach /Users/.../signatur`.

Die Schleife über die optionalen Dateien ist Absicht: `signatur.py`,
`relay_signatur.js` und `patch_relay.py` entstehen erst in Aufgabe 3, 4 und 5,
das Deploy muss aber schon jetzt funktionieren. Wichtig ist der Unterschied
zwischen `[ -f ]` und `|| true` — Ersteres prüft gezielt auf Nichtvorhandensein
und meldet es, Letzteres schluckt jede beliebige Fehlerursache dauerhaft.

Erwartete Ausgabe jetzt: drei `uebersprungen`-Zeilen, danach die sechs
Bausteinzeilen und `Deployt nach …`.

- [ ] **Schritt 10: Erzeugte Bausteine von der Versionierung ausnehmen**

```bash
printf 'tools/signatur/bereich-*.html\n' >> .gitignore
git check-ignore -v tools/signatur/bereich-ai.html
```
Erwartet: eine Zeile, die die neue `.gitignore`-Regel nennt.

- [ ] **Schritt 11: Committen**

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/signatur/bereiche.json tools/signatur/vorlage.html \
        tools/signatur/signatur_build.py tools/signatur/test_signatur_build.py \
        tools/signatur/deploy.sh .gitignore
git commit -m "feat(signatur): Generator, Bereichsdaten und Deploy-Skript"
```

---

### Task 3: Laufzeit-Bibliothek, Luna-Umstellung, sorbART stilllegen

Luna bekommt das neue Logo, die Logik wandert in eine gemeinsame Bibliothek, und der Bereich SORBART verschwindet. Diese Aufgabe ist ausdrücklich vor dem Relay dran: kleinster Wirkungskreis, und Lunas Pfad kann die Bausteine bereits lesen.

**Achtung — offener Vorgang:** In der Freigabe-Queue steht (Stand 04.08.) **ein** Eintrag mit `area: "SORBART"` auf `pending`. Wird SORBART aus `AREAS` entfernt, ohne den Eintrag vorher zu erledigen, scheitert dessen Versand bei der Freigabe. Schritt 1 klärt das.

**Files:**
- Create: `tools/signatur/signatur.py`
- Create: `tools/signatur/test_signatur.py`
- Modify: `tools/sekretaerin-mail-watcher/luna_mail_render.py` (Kopf, `SIGDIR`, `AREAS`, `load_sig`, `_IMG_DATA_RE`, `_sig_with_cid`, Aufrufstelle in `render_customer_html`)
- Replace: `tools/sekretaerin-mail-watcher/test_luna_mail_render.py` — **existiert bereits** (unittest-Stil, patcht `r.SIGDIR`) und wird vollständig ersetzt

**Interfaces:**
- Consumes: `bereich-<key>.html` aus Aufgabe 2
- Produces:
  - `signatur.absenderblock(name: str, rolle: str, hinweis: str) -> str`
  - `signatur.komponiere(bereich: str, block: str) -> str`
  - `signatur.zu_cid(html: str, ab_index: int = 0) -> tuple` — liefert `(html, anhaenge)`; `anhaenge` ist eine Liste aus `{"filename", "content", "mimeType", "cid"}`
  - `signatur.BEREICHE` — Liste der sechs Schlüssel
  - `signatur.VORGABE_BEREICH` — `"ai"`

- [ ] **Schritt 1: Den offenen SORBART-Vorgang klären**

```bash
/usr/bin/python3 - <<'EOF'
import json, glob
for f in glob.glob('/Users/walterschoenenbroecher.de/.paperclip/state/luna-approvals/*.json'):
    d = json.load(open(f))
    if d.get('area') == 'SORBART' and d.get('status') == 'pending':
        print(f)
        print('  an:', d.get('to'), '|', d.get('subject'))
EOF
```

Ergebnis Walter vorlegen: entweder er gibt den Vorgang **jetzt** noch frei (dann erst danach weitermachen), oder der Eintrag wird auf `cancelled` gesetzt:

```bash
/usr/bin/python3 - <<'EOF'
import json, glob
for f in glob.glob('/Users/walterschoenenbroecher.de/.paperclip/state/luna-approvals/*.json'):
    d = json.load(open(f))
    if d.get('area') == 'SORBART' and d.get('status') == 'pending':
        d['status'] = 'cancelled'
        d['cancel_grund'] = 'Bereich sorbART stillgelegt (04.08.2026)'
        json.dump(d, open(f, 'w'), ensure_ascii=False, indent=2)
        print('storniert:', f)
EOF
```

Erst weitermachen, wenn kein `SORBART`/`pending` mehr übrig ist.

- [ ] **Schritt 2: Den fehlschlagenden Test für die Bibliothek schreiben**

Datei `tools/signatur/test_signatur.py`:

```python
from __future__ import annotations

import pytest

import signatur


def test_absenderblock_enthaelt_name_rolle_und_hinweis():
    block = signatur.absenderblock("CTO", "KI-Agent", "Automatisch erstellt.")
    assert "i.A. CTO" in block
    assert "KI-Agent" in block
    assert "Automatisch erstellt." in block


def test_absenderblock_maskiert_html():
    block = signatur.absenderblock("A<b>B", "R&D", "x<y")
    assert "<b>" not in block
    assert "A&lt;b&gt;B" in block
    assert "R&amp;D" in block


def test_komponiere_ersetzt_den_platzhalter():
    html = signatur.komponiere("ai", "<div>BLOCK</div>")
    assert "{{ABSENDERBLOCK}}" not in html
    assert "<div>BLOCK</div>" in html
    assert "ws@whitestag.ai" in html


def test_komponiere_kennt_alle_sechs_bereiche():
    assert len(signatur.BEREICHE) == 6
    for k in signatur.BEREICHE:
        assert "{{ABSENDERBLOCK}}" not in signatur.komponiere(k, "<i>x</i>")


def test_sorbart_ist_kein_bereich_mehr():
    assert "sorbart" not in signatur.BEREICHE
    with pytest.raises(ValueError):
        signatur.komponiere("sorbart", "<i>x</i>")


def test_komponiere_wirft_bei_unbekanntem_bereich():
    with pytest.raises(ValueError):
        signatur.komponiere("gibtsnicht", "<i>x</i>")


def test_zu_cid_ersetzt_base64_durch_cid_referenz():
    html, anhaenge = signatur.zu_cid(signatur.komponiere("ai", "<i>x</i>"))
    assert "data:image/png;base64," not in html
    assert 'src="cid:attachment_0"' in html
    assert len(anhaenge) == 1
    assert anhaenge[0]["cid"] == "attachment_0"
    assert anhaenge[0]["mimeType"] == "image/png"
    assert len(anhaenge[0]["content"]) > 1000


def test_zu_cid_beachtet_den_startindex():
    """Der kritische Fall: die Mail bringt bereits Anhaenge mit."""
    html, anhaenge = signatur.zu_cid(
        signatur.komponiere("ai", "<i>x</i>"), ab_index=3
    )
    assert 'src="cid:attachment_3"' in html
    assert anhaenge[0]["cid"] == "attachment_3"


def test_zu_cid_ohne_bild_bleibt_unveraendert():
    html, anhaenge = signatur.zu_cid("<p>kein Bild</p>")
    assert html == "<p>kein Bild</p>"
    assert anhaenge == []


def test_vorgabe_bereich_ist_ai():
    assert signatur.VORGABE_BEREICH == "ai"
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd tools/signatur && /usr/bin/python3 -m pytest test_signatur.py -v`
Erwartet: `ModuleNotFoundError: No module named 'signatur'`.

- [ ] **Schritt 4: Die Bibliothek schreiben**

Datei `tools/signatur/signatur.py`:

```python
#!/usr/bin/env python3
"""Laufzeit-Bibliothek fuer die Mail-Signaturen.

Setzt den absenderspezifischen i.A.-Block in einen Bereichsbaustein ein und
wandelt das eingebettete base64-Logo in eine Inline-CID-Referenz um.

Outlook/Exchange entfernt data:-URIs, darum die CID-Variante: der Relay-Node
"Build Binary Attachments" legt Anhaenge unter dem Binaer-Property-Namen
`attachment_<index>` ab, und nodemailer nutzt GENAU DIESEN NAMEN als
Content-ID. Ein abweichendes cid-Feld wird ignoriert. Der Index muss deshalb
zur endgueltigen Position im attachments-Array passen — dafuer `ab_index`.
"""
from __future__ import annotations

import html as htmllib
import os
import re

HIER = os.path.dirname(os.path.abspath(__file__))

BEREICHE = ["ai", "film", "tv", "academy", "app", "de"]
VORGABE_BEREICH = "ai"

PLATZHALTER = "{{ABSENDERBLOCK}}"

_IMG_DATA_RE = re.compile(
    r'<img([^>]*?)src="data:(image/[a-zA-Z0-9.+-]+);base64,([^"]+)"([^>]*)>'
)


def absenderblock(name: str, rolle: str, hinweis: str) -> str:
    """Die Zeilen, die den Absender kennzeichnen."""
    return (
        '   <div style="font-size:13px;color:#222;">'
        '<strong>i.A. %s</strong> – %s</div>\n'
        '   <div style="font-size:11px;color:#888;line-height:1.4;'
        'margin-top:4px;max-width:780px;">%s</div>'
    ) % (
        htmllib.escape(name),
        htmllib.escape(rolle),
        htmllib.escape(hinweis),
    )


def komponiere(bereich: str, block: str) -> str:
    """Bereichsbaustein laden und den Absenderblock einsetzen."""
    if bereich not in BEREICHE:
        raise ValueError("Unbekannter Bereich: %s" % bereich)
    pfad = os.path.join(HIER, "bereich-%s.html" % bereich)
    with open(pfad, encoding="utf-8") as fh:
        return fh.read().replace(PLATZHALTER, block)


def zu_cid(sig_html: str, ab_index: int = 0):
    """Ersetzt base64-<img> durch cid:-Referenzen.

    Liefert (html, anhaenge). `ab_index` ist die Position, an der die
    erzeugten Anhaenge im endgueltigen attachments-Array stehen werden.
    """
    anhaenge = []

    def repl(m):
        idx = ab_index + len(anhaenge)
        mime = m.group(2)
        endung = mime.split("/")[-1]
        anhaenge.append({
            "filename": "logo-%d.%s" % (idx, endung),
            "content": m.group(3),
            "mimeType": mime,
            "cid": "attachment_%d" % idx,
        })
        return '<img%ssrc="cid:attachment_%d"%s>' % (m.group(1), idx, m.group(4))

    return _IMG_DATA_RE.sub(repl, sig_html), anhaenge
```

- [ ] **Schritt 5: Tests laufen lassen, grün bestätigen**

Ausführen: `/usr/bin/python3 -m pytest test_signatur.py -v`
Erwartet: 10 passed.

- [ ] **Schritt 6: Den fehlschlagenden Test für Luna schreiben**

Datei `tools/sekretaerin-mail-watcher/test_luna_mail_render.py` (bestehenden Inhalt vollständig ersetzen):

```python
from __future__ import annotations

import pytest

import luna_mail_render as lmr


def test_nur_noch_ai_und_film():
    assert set(lmr.AREAS) == {"AI", "FILM"}


def test_sorbart_wird_abgewiesen():
    with pytest.raises(KeyError):
        lmr.load_sig("SORBART")


def test_load_sig_liefert_lunas_absenderblock():
    for area in ["AI", "FILM"]:
        sig = lmr.load_sig(area)
        assert "i.A. Luna" in sig, area
        assert "KI-Assistentin" in sig, area
        assert "{{ABSENDERBLOCK}}" not in sig, area


def test_luna_hinweiszeile_nennt_walters_freigabe():
    # Bei Luna trifft das zu — die Vier-Augen-Freigabe haengt davor.
    assert "geprüft und freigegeben" in lmr.load_sig("AI")


def test_bereichsdaten_passen_zum_area_key():
    assert "ws@whitestag.ai" in lmr.load_sig("AI")
    assert "ws@whitestag.film" in lmr.load_sig("FILM")


def test_unbekannter_area_wirft():
    with pytest.raises(KeyError):
        lmr.load_sig("GIBTSNICHT")


def test_render_customer_html_liefert_cid_und_anhang():
    html, anhaenge = lmr.render_customer_html("AI", "Guten Tag\n\nDanke.")
    assert "data:image/png;base64," not in html
    assert 'src="cid:attachment_0"' in html
    assert len(anhaenge) == 1
    assert anhaenge[0]["cid"] == "attachment_0"


def test_render_customer_html_schneidet_eigene_grussformel_ab():
    html, _ = lmr.render_customer_html(
        "AI", "Guten Tag\n\nDanke.\n\nViele Grüße\nLuna\nirgendein Disclaimer"
    )
    assert "irgendein Disclaimer" not in html


def test_signatur_kommt_nach_dem_antworttext():
    html, _ = lmr.render_customer_html("AI", "Antworttext hier.")
    assert html.index("Antworttext hier.") < html.index("i.A. Luna")
```

- [ ] **Schritt 7: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd tools/sekretaerin-mail-watcher && /usr/bin/python3 -m pytest test_luna_mail_render.py -v`
Erwartet: `test_nur_noch_ai_und_film` und `test_sorbart_wird_abgewiesen` schlagen fehl — SORBART ist noch in `AREAS`.

- [ ] **Schritt 8: Luna auf die Bibliothek umstellen**

In `luna_mail_render.py` den Kopf bis einschließlich `_sig_with_cid` ersetzen. `strip_self_signoff`, `md_to_html` und `render_customer_html` bleiben inhaltlich unverändert — nur die Signaturherkunft ändert sich.

Neuer Kopf anstelle der bisherigen Zeilen 1–10 (`SIGDIR`/`AREAS`-Block):

```python
# luna_mail_render.py
"""Geteiltes Rendering: Antwort-Markdown -> Kunden-HTML inkl. Bereichs-Signatur.

Die Signaturbausteine liegen seit 08/2026 im Geschwisterordner `signatur/`
und werden mit den Agentenmails geteilt. Luna rendert weiterhin
client-seitig, weil die fertige Fassung schon fuer die Telegram-Vorschau
gebraucht wird — der Relay bekommt deshalb `signatur: "none"`.

SORBART wurde am 04.08.2026 stillgelegt.
"""
from __future__ import annotations
import html as htmllib
import os
import re
import sys

# Geschwisterordner — trifft Repo (tools/signatur) und Live
# (~/.paperclip/scripts/signatur) gleichermassen, ohne Sonderfall.
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "signatur"))
import signatur  # noqa: E402

AREAS = {"AI": "ai", "FILM": "film"}

LUNA_NAME = "Luna"
LUNA_ROLLE = "KI-Assistentin"
LUNA_HINWEIS = (
    "Diese Nachricht wurde von Luna, unserer KI-Assistentin, vorbereitet "
    "und von Walter Schönenbröcher persönlich geprüft und freigegeben."
)
```

`load_sig` ersetzen durch:

```python
def load_sig(area: str) -> str:
    """Bereichssignatur mit Lunas Absenderblock."""
    bereich = AREAS[area]  # KeyError bei unbekanntem Area — gewollt
    block = signatur.absenderblock(LUNA_NAME, LUNA_ROLLE, LUNA_HINWEIS)
    return signatur.komponiere(bereich, block)
```

`_IMG_DATA_RE` und `_sig_with_cid` ersatzlos streichen. In `render_customer_html` die Zeile

```python
    sig, attachments = _sig_with_cid(load_sig(area))
```

ersetzen durch

```python
    sig, attachments = signatur.zu_cid(load_sig(area))
```

- [ ] **Schritt 9: Tests laufen lassen, grün bestätigen**

Ausführen: `cd tools/sekretaerin-mail-watcher && /usr/bin/python3 -m pytest test_luna_mail_render.py -v`
Erwartet: 9 passed.

- [ ] **Schritt 10: Prüfen, dass `--area SORBART` jetzt sauber abgewiesen wird**

`luna-queue-approval.py` validiert gegen `list(render.AREAS)`. Ausführen:

```bash
AGENTBIN=~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/e24b8d9d-143e-4141-b413-4361aa618771/bin
/usr/bin/python3 "$AGENTBIN/luna-queue-approval.py" --help 2>&1 | grep -i "area"
```
Erwartet: `--area {AI,FILM}` — SORBART ist nicht mehr wählbar.

- [ ] **Schritt 11: Deployen und prüfen, dass der Watcher die Bibliothek findet**

Erst jetzt geht die Änderung live. Beide Ordner deployen — `signatur/` wegen
der Bausteine, `sekretaerin-mail-watcher/` wegen des geänderten Renderers:

```bash
tools/signatur/deploy.sh
for f in tools/sekretaerin-mail-watcher/*.py; do
  b=$(basename "$f"); case "$b" in test_*) continue;; esac
  cp "$f" ~/.paperclip/scripts/sekretaerin-mail-watcher/"$b"
done
diff -q tools/sekretaerin-mail-watcher/luna_mail_render.py \
        ~/.paperclip/scripts/sekretaerin-mail-watcher/luna_mail_render.py && echo "live == repo"
```

Der LaunchAgent startet `/usr/bin/python3 watcher.py` mit `WorkingDirectory` im
Watcher-Ordner. Der `sys.path`-Eintrag ist relativ zur Moduldatei, greift also
unabhängig vom Arbeitsverzeichnis — und findet live wie im Repo den
Geschwisterordner `signatur/`.

```bash
cd /tmp && /usr/bin/python3 -c "
import sys; sys.path.insert(0, '/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher')
import luna_mail_render as l
h, a = l.render_customer_html('FILM', 'Test.')
print('ok', len(h), len(a), a[0]['cid'])
"
```
Erwartet: `ok <zahl> 1 attachment_0`

- [ ] **Schritt 12: Optische Endkontrolle des neuen Logos**

```bash
/usr/bin/python3 -c "
import sys; sys.path.insert(0, 'tools/signatur')
import signatur
open('/tmp/luna-neu.html','w').write(
    signatur.komponiere('ai', signatur.absenderblock(
        'Luna','KI-Assistentin','Diese Nachricht wurde von Luna vorbereitet.')))
"
open /tmp/luna-neu.html
```
Erwartet: der fotorealistische Hirsch mit „Künstliche Intelligenz", **nicht** der orange Drahtgitter-Hirsch.

- [ ] **Schritt 13: Alte Signaturdateien stilllegen, nicht löschen**

```bash
cd ~/Obsidian/WHITESTAG-Vault/Paperclip/Luna/signaturen
mkdir -p abgeloest-20260804
mv signatur-ai.html signatur-film.html signatur-sorbart.html abgeloest-20260804/
```

Verschieben statt löschen, damit der Rollback ein `mv` zurück ist. Die `.bak-*`-Dateien bleiben liegen, wo sie sind.

- [ ] **Schritt 14: Committen**

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/signatur/signatur.py tools/signatur/test_signatur.py
git commit -m "feat(signatur): Laufzeit-Bibliothek fuer Absenderblock und CID-Logo"
git add tools/sekretaerin-mail-watcher/luna_mail_render.py \
        tools/sekretaerin-mail-watcher/test_luna_mail_render.py
git commit -m "feat(luna): geteilte Signaturbausteine, neues Logo, sorbART stillgelegt"
```

---

### Task 4: Signaturlogik für den n8n-Code-Node

Der Node läuft in n8n, also JavaScript. Die Logik ist dieselbe wie in `signatur.py`, deshalb wird sie hier gegen dieselben Fälle getestet.

**Files:**
- Create: `tools/signatur/relay_signatur.js`
- Test: `tools/signatur/test_relay_signatur.mjs`

**Interfaces:**
- Consumes: `bereich-<key>.html` aus Aufgabe 2
- Produces: `signiere(json, leseDatei)` — nimmt das Item-`json` des Relays und eine Lesefunktion `(pfad) => string`, liefert das veränderte `json`. Der Node selbst ruft das mit `require('fs').readFileSync` auf.
- Produces: `ABSENDER` — Zuordnung Absenderadresse → `{name, rolle}`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

Datei `test_relay_signatur.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { signiere, ABSENDER } = require(path.join(HIER, 'relay_signatur.js'));

const lies = (p) => fs.readFileSync(p, 'utf8');
const basis = (extra = {}) => ({
  from: 'cto@whitestag.ai',
  to: 'ws@whitestag.ai',
  subject: 'Test',
  html: '<p>Inhalt</p>',
  text: 'Inhalt',
  attachments: [],
  ...extra,
});

test('alle zehn whitestag-Absender sind hinterlegt', () => {
  const erwartet = ['ceo', 'cmo', 'cto', 'cpo', 'cro', 'creative', 'dpo',
                    'webdesign', 'health', 'office'];
  for (const k of erwartet) {
    assert.ok(ABSENDER[`${k}@whitestag.ai`], k);
  }
});

test('haengt Signatur an das HTML an', () => {
  const j = signiere(basis(), lies);
  assert.ok(j.html.includes('i.A. CTO'));
  assert.ok(j.html.includes('ws@whitestag.ai'));
  assert.ok(j.html.indexOf('<p>Inhalt</p>') < j.html.indexOf('i.A. CTO'));
});

test('haengt eine Textfassung ohne Logo an den Text an', () => {
  const j = signiere(basis(), lies);
  assert.ok(j.text.includes('i.A. CTO'));
  assert.ok(j.text.includes('übernimmt keine Haftung'));
  assert.ok(!j.text.includes('base64'));
});

test('waehlt den Bereich aus dem Feld bereich', () => {
  const j = signiere(basis({ bereich: 'film' }), lies);
  assert.ok(j.html.includes('ws@whitestag.film'));
  assert.ok(j.html.includes('VR Filmproduktion'));
});

test('faellt ohne bereich auf ai zurueck', () => {
  const j = signiere(basis(), lies);
  assert.ok(j.html.includes('ws@whitestag.ai'));
});

test('faellt bei unbekanntem bereich auf ai zurueck', () => {
  const j = signiere(basis({ bereich: 'quatsch' }), lies);
  assert.ok(j.html.includes('ws@whitestag.ai'));
});

test('sorbart ist kein gueltiger Bereich mehr', () => {
  const j = signiere(basis({ bereich: 'sorbart' }), lies);
  assert.ok(j.html.includes('ws@whitestag.ai'));
  assert.ok(!j.html.includes('sorbART'));
});

test('signatur none laesst alles unveraendert', () => {
  const j = signiere(basis({ signatur: 'none' }), lies);
  assert.equal(j.html, '<p>Inhalt</p>');
  assert.equal(j.attachments.length, 0);
});

test('unbekannter Absender wird nicht signiert', () => {
  const j = signiere(basis({ from: 'paperclip@clara-werden.de' }), lies);
  assert.equal(j.html, '<p>Inhalt</p>');
  assert.equal(j.attachments.length, 0);
});

test('KRITISCH: Logo landet hinter bestehenden Anhaengen', () => {
  const j = signiere(basis({
    attachments: [
      { filename: 'a.xlsx', content: 'AAA', mimeType: 'application/vnd.ms-excel' },
      { filename: 'b.pdf', content: 'BBB', mimeType: 'application/pdf' },
    ],
  }), lies);
  assert.equal(j.attachments.length, 3);
  assert.equal(j.attachments[0].filename, 'a.xlsx');
  assert.equal(j.attachments[1].filename, 'b.pdf');
  assert.equal(j.attachments[2].cid, 'attachment_2');
  assert.ok(j.html.includes('src="cid:attachment_2"'));
  assert.ok(!j.html.includes('data:image/png;base64,'));
});

test('reine Textmail bekommt keinen Logo-Anhang', () => {
  const j = signiere(basis({ html: undefined }), lies);
  assert.ok(j.text.includes('i.A. CTO'));
  assert.equal(j.attachments.length, 0);
});

test('fehlender Baustein blockiert den Versand nicht', () => {
  const kaputt = () => { throw new Error('ENOENT'); };
  const j = signiere(basis(), kaputt);
  assert.equal(j.html, '<p>Inhalt</p>');
  assert.equal(j.attachments.length, 0);
  assert.ok(j.__signaturFehler.includes('ENOENT'));
});

test('office bekommt Lunas Bezeichnung', () => {
  const j = signiere(basis({ from: 'office@whitestag.ai' }), lies);
  assert.ok(j.html.includes('i.A. Luna'));
  assert.ok(j.html.includes('KI-Assistentin'));
});
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `cd tools/signatur && node --test test_relay_signatur.mjs`
Erwartet: Fehler `Cannot find module .../relay_signatur.js`.

- [ ] **Schritt 3: Die Logik schreiben**

Datei `relay_signatur.js`:

```javascript
// Signaturlogik des SMTP-Relays.
//
// Spiegelt signatur.py. Wird als Code-Node "Attach Signature" in den Relay
// eingesetzt (siehe patch_relay.py) und liegt hier als eigene Datei, damit
// sie testbar bleibt.
//
// GRUNDREGEL: Diese Funktion darf niemals werfen. Der Relay ist der einzige
// Mailweg; ueber ihn laufen auch die Waechter-Alarme. Im Fehlerfall geht die
// Mail ohne Signatur raus und __signaturFehler traegt den Grund.

const BAUSTEIN_VERZEICHNIS =
  '/Users/walterschoenenbroecher.de/.paperclip/scripts/signatur';

const BEREICHE = ['ai', 'film', 'tv', 'academy', 'app', 'de'];
const VORGABE_BEREICH = 'ai';

const ABSENDER = {
  'ceo@whitestag.ai':       { name: 'CEO', rolle: 'KI-Agent' },
  'cmo@whitestag.ai':       { name: 'CMO', rolle: 'KI-Agent' },
  'cto@whitestag.ai':       { name: 'CTO', rolle: 'KI-Agent' },
  'cpo@whitestag.ai':       { name: 'CPO', rolle: 'KI-Agent' },
  'cro@whitestag.ai':       { name: 'CRO', rolle: 'KI-Agent' },
  'creative@whitestag.ai':  { name: 'Creative Director', rolle: 'KI-Agent' },
  'dpo@whitestag.ai':       { name: 'DPO', rolle: 'KI-Agent' },
  'webdesign@whitestag.ai': { name: 'Web-Design Specialist', rolle: 'KI-Agent' },
  'health@whitestag.ai':    { name: 'CHO', rolle: 'KI-Agent' },
  // office@ ist Luna. Sie signiert selbst und sendet signatur:"none" — der
  // Eintrag ist das Sicherheitsnetz, falls ein Skript als office@ ohne
  // eigene Signatur sendet.
  'office@whitestag.ai':    { name: 'Luna', rolle: 'KI-Assistentin' },
};

function maskiere(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hinweisFuer(eintrag) {
  if (eintrag.rolle === 'KI-Assistentin') {
    return 'Diese Nachricht wurde von Luna, unserer KI-Assistentin, vorbereitet.';
  }
  return `Diese Nachricht wurde vom KI-Agenten „${eintrag.name}" automatisch erstellt.`;
}

function absenderblock(eintrag) {
  return (
    `   <div style="font-size:13px;color:#222;">` +
    `<strong>i.A. ${maskiere(eintrag.name)}</strong> – ${maskiere(eintrag.rolle)}</div>\n` +
    `   <div style="font-size:11px;color:#888;line-height:1.4;` +
    `margin-top:4px;max-width:780px;">${maskiere(hinweisFuer(eintrag))}</div>`
  );
}

// HTML -> Klartext fuer den text/plain-Teil. Bewusst schlicht: Tags raus,
// Bloecke zu Zeilenumbruechen, Entities zurueck.
function zuText(html) {
  return html
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/(div|tr|p|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .split('\n').map((z) => z.trim()).filter((z) => z !== '')
    .join('\n');
}

function signiere(json, leseDatei) {
  try {
    if (json.signatur === 'none') return json;

    const from = String(json.from || '').trim().toLowerCase();
    const eintrag = ABSENDER[from];
    if (!eintrag) return json;

    let bereich = String(json.bereich || '').trim().toLowerCase();
    if (!BEREICHE.includes(bereich)) bereich = VORGABE_BEREICH;

    const roh = leseDatei(`${BAUSTEIN_VERZEICHNIS}/bereich-${bereich}.html`);
    const sig = roh.replace('{{ABSENDERBLOCK}}', absenderblock(eintrag));

    // Textfassung immer, unabhaengig vom HTML-Teil.
    if (json.text) json.text = `${json.text}\n\n--\n${zuText(sig)}`;

    if (!json.html) return json;

    // Der Lookbehind (?<=[\s"']) verlangt eine echte Attributgrenze vor src.
    // Ohne ihn traefe die Regex auch das Ende eines anderen Attributnamens
    // (z.B. data-src) und schriebe das falsche Attribut um — still falsch
    // statt still abwesend. Muss identisch zu signatur.py bleiben.
    // Logo ans ENDE des attachments-Arrays. Der Index muss die endgueltige
    // Position treffen: "Build Binary Attachments" benennt die Binaerfelder
    // attachment_<index>, und nodemailer nimmt genau diesen Namen als
    // Content-ID. Bei 0 zu beginnen wuerde die erste echte Anlage
    // ueberschreiben.
    const anhaenge = Array.isArray(json.attachments) ? json.attachments : [];
    const index = anhaenge.length;
    const mitCid = sig.replace(
      /<img([^>]*?)(?<=[\s"'])src="data:(image\/[a-zA-Z0-9.+-]+);base64,([^"]+)"([^>]*)>/,
      (_m, vor, mime, daten, nach) => {
        anhaenge.push({
          filename: `logo-${index}.${mime.split('/')[1]}`,
          content: daten,
          mimeType: mime,
          cid: `attachment_${index}`,
        });
        return `<img${vor}src="cid:attachment_${index}"${nach}>`;
      },
    );

    json.html = `${json.html}\n<br>\n${mitCid}`;
    json.attachments = anhaenge;
    return json;
  } catch (err) {
    json.__signaturFehler = String((err && err.message) || err);
    return json;
  }
}

module.exports = { signiere, absenderblock, zuText, ABSENDER, BEREICHE,
                   VORGABE_BEREICH, BAUSTEIN_VERZEICHNIS };
```

- [ ] **Schritt 4: Tests laufen lassen, grün bestätigen**

Ausführen: `node --test test_relay_signatur.mjs`
Erwartet: `# pass 13`, `# fail 0`.

- [ ] **Schritt 5: Gegen die Python-Fassung abgleichen**

Beide Implementierungen müssen dieselbe Signatur erzeugen. Ausführen:

```bash
cd tools/signatur
node -e "
const {signiere} = require('./relay_signatur.js');
const fs = require('fs');
const j = signiere({from:'cto@whitestag.ai', html:'<p>x</p>', text:'x', attachments:[]},
                   (p)=>fs.readFileSync(p,'utf8'));
fs.writeFileSync('/tmp/sig-js.html', j.html);
"
/usr/bin/python3 -c "
import sys; sys.path.insert(0,'.')
import signatur
h,_ = signatur.zu_cid(signatur.komponiere('ai', signatur.absenderblock(
    'CTO','KI-Agent','Diese Nachricht wurde vom KI-Agenten „CTO\" automatisch erstellt.')))
open('/tmp/sig-py.html','w').write('<p>x</p>\n<br>\n'+h)
"
diff /tmp/sig-js.html /tmp/sig-py.html && echo IDENTISCH
```
Erwartet: `IDENTISCH`. Bei Abweichung die JS-Fassung angleichen — `signatur.py` ist die Referenz.

- [ ] **Schritt 6: Committen**

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/signatur/relay_signatur.js tools/signatur/test_relay_signatur.mjs
git commit -m "feat(signatur): Signaturlogik fuer den Relay-Code-Node"
tools/signatur/deploy.sh   # damit patch_relay.py in Aufgabe 5 die Datei live findet
```

---

### Task 5: Relay-Workflow patchen und in Betrieb nehmen

Der heikelste Schritt. Der Relay ist der einzige Mailweg; ein Fehler hier legt auch die Wächter-Alarme still.

**Ausgangslage:** Workflow `BXHc5kdNdZQNiuMr`, Name `SMTP Relay V16 — Office Freigabe-gated`, aktiv. Verdrahtung an der Einsatzstelle:
`Validation Error?` Ausgang **1** (der Nein-Zweig) → `Build Binary Attachments` → `Switch by Sender`.

**Präzisierung gegenüber der Spec:** Dort steht „zwischen `Validate Request` und `Build Binary Attachments`". Diese beiden sind nicht direkt verbunden — dazwischen sitzt `Validation Error?`. Der neue Node kommt an Ausgang 1 von `Validation Error?`.

**Files:**
- Create: `tools/signatur/patch_relay.py`
- Modify: `tools/sekretaerin-mail-watcher/approval_send.py` (Feld `signatur: "none"`)
- Modify: n8n-Workflow (neue Version V17)

**Interfaces:**
- Consumes: `relay_signatur.js` aus Aufgabe 4
- Produces: aktiver Workflow `SMTP Relay V17 — Signatur` mit dem Node `Attach Signature`

- [ ] **Schritt 1: Sicherung anlegen**

```bash
mkdir -p ~/.paperclip/scripts/signatur/backup
cd ~/.n8n
sqlite3 database.sqlite \
  "select json_object('nodes', json(nodes), 'connections', json(connections), 'name', name) \
   from workflow_entity where id='BXHc5kdNdZQNiuMr';" \
  > ~/.paperclip/scripts/signatur/backup/relay-v16-$(date +%Y%m%d-%H%M%S).json
ls -la ~/.paperclip/scripts/signatur/backup/
```
Erwartet: eine JSON-Datei deutlich über 10 KB.

- [ ] **Schritt 2: Luna schickt `signatur: "none"`**

Ohne dieses Feld bekämen Lunas Mails zwei Signaturen. Zuerst prüfen:

```bash
grep -n "signatur" tools/sekretaerin-mail-watcher/approval_send.py
```

Fehlt es, in `approval_send.py` im Payload-Dictionary (dort, wo `"from": FROM, "to": entry["to"], …` steht) ergänzen:

```python
        "signatur": "none",  # Luna signiert selbst (Vorschau vor Freigabe)
```

Verifizieren:
```bash
grep -n '"signatur": "none"' tools/sekretaerin-mail-watcher/approval_send.py
```
Erwartet: genau ein Treffer.

- [ ] **Schritt 3: Das Patch-Werkzeug schreiben**

Datei `patch_relay.py`:

```python
#!/usr/bin/env python3
"""Klont den SMTP-Relay auf eine neue Version und haengt den Signatur-Node ein.

Der Node-Code stammt aus relay_signatur.js — module.exports wird entfernt und
ein n8n-Aufrufrahmen angehaengt, damit es genau eine Quelle gibt.

Nutzung:
    python3 patch_relay.py --dry-run   # zeigt nur, was passieren wuerde
    python3 patch_relay.py --apply     # legt V17 an (noch nicht aktiv)
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import uuid

HIER = os.path.dirname(os.path.abspath(__file__))
DB = os.path.expanduser("~/.n8n/database.sqlite")
QUELL_ID = "BXHc5kdNdZQNiuMr"
NEUE_ID = "SMTPRelayV17Signat"
NEUER_NAME = "SMTP Relay V17 — Signatur"
NODE_NAME = "Attach Signature"

RAHMEN = """
// --- n8n-Aufrufrahmen (angehaengt von patch_relay.py) --------------------
const fsModul = require('fs');
const leseDatei = (p) => fsModul.readFileSync(p, 'utf8');
return $input.all().map((item) => ({ json: signiere(item.json, leseDatei) }));
"""


def node_code() -> str:
    """relay_signatur.js ohne CommonJS-Export, dafuer mit n8n-Aufrufrahmen."""
    with open(os.path.join(HIER, "relay_signatur.js"), encoding="utf-8") as fh:
        code = fh.read()
    # Der Export erstreckt sich ueber zwei Zeilen — beide raus.
    kopf, _, _rest = code.partition("module.exports")
    return kopf.rstrip() + "\n" + RAHMEN


def baue(nodes, connections):
    neu = json.loads(json.dumps(nodes))
    verb = json.loads(json.dumps(connections))

    # Position: leicht versetzt neben Build Binary Attachments.
    ziel_pos = [0, 0]
    for n in neu:
        if n["name"] == "Build Binary Attachments":
            ziel_pos = [n["position"][0] - 180, n["position"][1] - 120]

    neu.append({
        "parameters": {"jsCode": node_code()},
        "id": str(uuid.uuid4()),
        "name": NODE_NAME,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": ziel_pos,
    })

    # Validation Error? Ausgang 1 zeigt kuenftig auf den Signatur-Node,
    # der Signatur-Node auf Build Binary Attachments.
    zweig = verb["Validation Error?"]["main"][1]
    assert any(t["node"] == "Build Binary Attachments" for t in zweig), \
        "Erwartete Verdrahtung nicht gefunden — Workflow hat sich geaendert"
    verb["Validation Error?"]["main"][1] = [
        {"node": NODE_NAME, "type": "main", "index": 0}
    ]
    verb[NODE_NAME] = {
        "main": [[{"node": "Build Binary Attachments", "type": "main", "index": 0}]]
    }
    return neu, verb


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    a = p.parse_args()
    if not (a.dry_run or a.apply):
        print("Kein Modus. --dry-run oder --apply.", file=sys.stderr)
        return 2

    con = sqlite3.connect(DB)
    row = con.execute(
        "select nodes, connections from workflow_entity where id=?",
        (QUELL_ID,),
    ).fetchone()
    if not row:
        print("Quellworkflow nicht gefunden: " + QUELL_ID, file=sys.stderr)
        return 2

    nodes, verb = baue(json.loads(row[0]), json.loads(row[1]))
    print("Nodes: %d -> %d" % (len(json.loads(row[0])), len(nodes)))
    print("Neuer Node: %s" % NODE_NAME)
    print("Validation Error?[1] -> %s -> Build Binary Attachments" % NODE_NAME)

    if a.dry_run:
        print("(dry-run, nichts geschrieben)")
        return 0

    vorhanden = con.execute(
        "select 1 from workflow_entity where id=?", (NEUE_ID,)
    ).fetchone()
    if vorhanden:
        print("V17 existiert bereits — erst loeschen oder ID anpassen.",
              file=sys.stderr)
        return 2

    con.execute(
        "insert into workflow_entity (id, name, active, nodes, connections, "
        "settings, createdAt, updatedAt) "
        "select ?, ?, 0, ?, ?, settings, datetime('now'), datetime('now') "
        "from workflow_entity where id=?",
        (NEUE_ID, NEUER_NAME, json.dumps(nodes), json.dumps(verb), QUELL_ID),
    )
    con.commit()
    print("V17 angelegt (inaktiv): " + NEUE_ID)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Schritt 4: Trockenlauf**

Ausführen: `cd tools/signatur && /usr/bin/python3 patch_relay.py --dry-run`
Erwartet: `Nodes: 20 -> 21` und die drei Verdrahtungszeilen. Bricht die Zusicherung ab, hat sich der Workflow geändert — dann Verdrahtung neu ermitteln, bevor es weitergeht.

- [ ] **Schritt 5: V17 anlegen**

Ausführen: `/usr/bin/python3 patch_relay.py --apply`
Erwartet: `V17 angelegt (inaktiv)`.

- [ ] **Schritt 6: In der n8n-Oberfläche prüfen**

n8n muss neu gestartet werden, damit die direkt in die SQLite geschriebene Version sichtbar wird:
```bash
~/.n8n/start-n8n.sh
```

Dann `http://127.0.0.1:5678` öffnen, Workflow `SMTP Relay V17 — Signatur` öffnen. Erwartet: `Attach Signature` sitzt zwischen `Validation Error?` und `Build Binary Attachments`, der Node-Code ist vollständig und endet mit dem `return $input.all().map(...)`-Rahmen, keine roten Verbindungen.

- [ ] **Schritt 7: Umschalten**

Beide Schritte einzeln, in dieser Reihenfolge — n8n führt sonst weiter die alte `activeVersionId` aus:
```bash
source ~/.whitestag.env
curl -sS -X POST "http://127.0.0.1:5678/api/v1/workflows/BXHc5kdNdZQNiuMr/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | head -c 200; echo
curl -sS -X POST "http://127.0.0.1:5678/api/v1/workflows/SMTPRelayV17Signat/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | head -c 200; echo
```

Verifizieren:
```bash
sqlite3 ~/.n8n/database.sqlite "select id, name, active from workflow_entity where id in ('BXHc5kdNdZQNiuMr','SMTPRelayV17Signat');"
```
Erwartet: V16 `0`, V17 `1`.

- [ ] **Schritt 8: Ende-zu-Ende-Test, alle sechs Bereiche**

```bash
SECRET=$(grep -m1 'X-Mailhub-Secret:' \
  ~/Obsidian/WHITESTAG-Vault/Paperclip/_Meta/WHI-133-Mailhub-V1.md \
  | sed -E 's/.*`X-Mailhub-Secret: ([^`]+)`.*/\1/')
for b in ai film tv academy app de; do
  curl -sS -X POST http://127.0.0.1:5678/webhook/mailhub/send \
    -H "Content-Type: application/json" -H "X-Mailhub-Secret: $SECRET" \
    -d "{\"from\":\"cto@whitestag.ai\",\"to\":\"ws@whitestag.ai\",
         \"subject\":\"Signaturtest $b\",\"text\":\"Testtext.\",
         \"html\":\"<p>Testtext.</p>\",\"bereich\":\"$b\"}"
  echo " <- $b"
done
```
Erwartet: sechsmal `{"ok":true,...}`.

**Abnahme in Apple Mail und in Outlook:** Sechs Mails, jede mit dem richtigen Logo **inline** (kein Platzhalter, keine Aufforderung „Bilder herunterladen"), richtiger Bereichsdomain im Kontaktblock und `i.A. CTO – KI-Agent`.

- [ ] **Schritt 9: Der Kollisionsfall in echt**

Eine Mail mit einem echten Anhang senden und prüfen, dass Anhang **und** Logo ankommen:
```bash
echo "Testinhalt" > ~/Obsidian/WHITESTAG-Vault/Paperclip/_Meta/signaturtest.txt
curl -sS -X POST http://127.0.0.1:5678/webhook/mailhub/send \
  -H "Content-Type: application/json" -H "X-Mailhub-Secret: $SECRET" \
  -d '{"from":"cto@whitestag.ai","to":"ws@whitestag.ai",
       "subject":"Signaturtest mit Anhang","text":"Mit Anlage.",
       "html":"<p>Mit Anlage.</p>",
       "attachments":["/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault/Paperclip/_Meta/signaturtest.txt"]}'
```
Erwartet: Die Mail trägt `signaturtest.txt` als Anlage **und** das Logo inline. Falls die Anlage fehlt oder durch das Logo ersetzt wurde, ist der Index falsch — dann Aufgabe 4, Schritt 3 nachbessern.

Danach aufräumen: `rm ~/Obsidian/WHITESTAG-Vault/Paperclip/_Meta/signaturtest.txt`

- [ ] **Schritt 10: Lunas Weg prüfen**

Eine Mail durch die Freigabe-Queue schicken und prüfen, dass die Signatur **einfach** vorkommt. Kommt sie doppelt, greift `signatur: "none"` aus Schritt 2 nicht.

- [ ] **Schritt 11: Committen**

Zuerst den neuen Workflow als Export ins Repo legen — neben dem vorhandenen
`SMTP-Relay-V16.export.json`, damit der Stand nachvollziehbar bleibt:

```bash
sqlite3 ~/.n8n/database.sqlite \
  "select json_object('name', name, 'nodes', json(nodes), 'connections', json(connections)) \
   from workflow_entity where id='SMTPRelayV17Signat';" \
  | /usr/bin/python3 -m json.tool \
  > tools/sekretaerin-mail-watcher/SMTP-Relay-V17.export.json
wc -c tools/sekretaerin-mail-watcher/SMTP-Relay-V17.export.json
```
Erwartet: deutlich über 10 KB.

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/signatur/patch_relay.py \
        tools/sekretaerin-mail-watcher/approval_send.py \
        tools/sekretaerin-mail-watcher/SMTP-Relay-V17.export.json
git commit -m "feat(relay): Signatur-Node als V17 eingehaengt"
```

Die Sicherung unter `~/.paperclip/scripts/signatur/backup/` bleibt bewusst
ausserhalb des Repos — sie ist ein Wegwerf-Artefakt des Umstellungstags, der
Repo-Export ist der dauerhafte Nachweis.

- [ ] **Schritt 12: Änderungs- und Rollbackweg dokumentieren**

Datei `tools/signatur/README.md`:

```markdown
# Mail-Signaturen

Bausteine: `bereich-<key>.html`, erzeugt von `signatur_build.py` aus
`bereiche.json` + `vorlage.html` + `logos/`.
Bereiche: ai, film, tv, academy, app, de. sorbART wurde am 04.08.2026
stillgelegt.

## Etwas ändern

1. `bereiche.json` bzw. `logos/` anpassen (neues Logo: `logos_bauen.py`)
2. `python3 signatur_build.py`
3. Fertig — Relay und Luna lesen die Dateien zur Laufzeit.

Wird `relay_signatur.js` geändert, muss `signatur.py` mitgeändert werden und
umgekehrt. Der Abgleich steht in `test_relay_signatur.mjs` bzw. in Aufgabe 4,
Schritt 5 des Umsetzungsplans.

## Rollback

- Relay: V17 deaktivieren, V16 aktivieren (`/api/v1/workflows/<id>/activate`).
  Erst deaktivieren, dann aktivieren — sonst laeuft die alte activeVersionId weiter.
- Luna: `~/Obsidian/WHITESTAG-Vault/Paperclip/Luna/signaturen/abgeloest-20260804/`
  zurueckschieben und `luna_mail_render.py` aus git zuruecksetzen.

## Quelle und Live-Stand

Quelle ist `tools/signatur/` im Paperclip-Repo. Der Live-Pfad
`~/.paperclip/scripts/signatur/` entsteht nur durch `deploy.sh` — dort nie von
Hand editieren. Die `bereich-*.html` sind abgeleitet und gitignored; `deploy.sh`
erzeugt sie am Zielort neu.
```

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/signatur/README.md
git commit -m "docs(signatur): Aenderungs- und Rollbackweg"
```

---

### Task 6: Rollen-Anweisungen — Bereich dokumentieren, sorbART entfernen

Ohne diesen Schritt kennen die Agenten das Feld `bereich` nicht und alles läuft auf `ai`. Zugleich muss SORBART aus Lunas Anweisungen verschwinden, sonst wählt sie einen Bereich, den es nicht mehr gibt.

**Files:**
- Modify: `roles/ceo.role.md`, `cmo.role.md`, `cto.role.md`, `cpo.role.md`, `cro.role.md`, `creative-director.role.md`, `dpo.role.md` — Mailhub-Abschnitt
- Modify: `roles/sekret-rin.role.md` — SORBART entfernen (Zeilen um 26, 355, 393, 425, 438, 443, 481, 489)

**Interfaces:**
- Consumes: das Feld `bereich` aus Aufgabe 5
- Produces: nichts, was spätere Aufgaben nutzen

- [ ] **Schritt 1: Sicherung**

```bash
cd ~/.paperclip/scripts/agents-instructions
/usr/bin/python3 build-agents-md.py --backup
```

`--backup` und `--apply` **müssen getrennt** aufgerufen werden: `main()` kehrt nach dem ersten passenden Modus zurück, `--backup --apply` führt nur das Backup aus.

- [ ] **Schritt 2: Betroffene Stellen finden**

```bash
grep -ln "webhook/mailhub/send" roles/*.role.md | grep -v "\.bak"
grep -n "SORBART\|sorbart\|sorbART" roles/sekret-rin.role.md
```
Erwartet: acht Dateien mit Mailhub-Bezug; in `sekret-rin.role.md` acht bis zehn SORBART-Treffer.

- [ ] **Schritt 3: Textbaustein in die sieben C-Suite-Rollen einfügen**

In `ceo`, `cmo`, `cto`, `cpo`, `cro`, `creative-director` und `dpo` jeweils direkt nach dem JSON-Beispiel des Sendeaufrufs einfügen:

```markdown
**Signatur und Geschäftsbereich.** Deine Signatur hängt der Mailhub selbst an
— du schreibst sie **nicht** in `html` oder `text`. Mit dem optionalen Feld
`bereich` wählst du, welches WHITESTAG-Branding sie trägt:

| Wert | Bereich |
|---|---|
| `ai` | Artificial Intelligence (Vorgabe, wenn du nichts angibst) |
| `film` | VR Filmproduktion |
| `tv` | Television & Broadcast |
| `academy` | WHITESTAG.ACADEMY |
| `app` | WHITESTAG.APP |
| `de` | WHITESTAG.DE |

Wähle den Bereich nach dem **Inhalt** der Mail, nicht nach deiner Rolle: Eine
Mail über einen Dreh nimmt `film`, eine über ein Schulungsangebot `academy`.
Im Zweifel `ai` — oder das Feld weglassen, das ist dasselbe.

Schreibe **niemals** eine eigene Grußformel mit Kontaktdaten unter deinen
Text. Das ergibt eine doppelte Signatur.
```

- [ ] **Schritt 4: SORBART aus `sekret-rin.role.md` entfernen**

Vier Arten von Fundstellen, alle anfassen:

1. **Aufrufsyntax** (Zeilen um 26 und 355): `--area {AI|FILM|SORBART}` → `--area {AI|FILM}`, ebenso `<AI|FILM|SORBART>` → `<AI|FILM>`.
2. **Signaturhinweis** (um 393 und 443): Aufzählung `(AI / FILM / SORBART)` → `(AI / FILM)`. Den Pfadhinweis `Vault/Paperclip/Luna/signaturen/signatur-{ai,film,sorbart}.html` ersetzen durch `~/.paperclip/scripts/signatur/bereich-{ai,film}.html`.
3. **Zuordnungsregel** (um 425): Die Zeile `- \`…@sorbart.de\` / \`…@sorbart.shop\` → **SORBART**` ersetzen durch:

```markdown
   - `…@sorbart.de` / `…@sorbart.shop` → **kein eigener Bereich mehr.**
     sorbART wurde stillgelegt. Behandle solche Mails wie einen offenen
     Bereich: nicht raten, sondern die Rückfrage-Regel anwenden.
```

4. **Rückfrage-Antwortwerte** (um 438) und der **Wortlaut-Block** (um 481–489): `SORBART` aus der Liste der zulässigen Antworten streichen (übrig: `AI`, `FILM`, `PRIVAT`) und den kompletten sorbART-Signaturblock samt `sorbART UG`-Zeilen löschen.

- [ ] **Schritt 5: Prüfen, dass nichts übrig ist**

```bash
grep -in "sorbart" roles/sekret-rin.role.md | grep -v "stillgelegt\|sorbart.de\|sorbart.shop"
```
Erwartet: keine Ausgabe. Übrig bleiben dürfen nur die Absenderdomains in der Zuordnungsregel und das Wort „stillgelegt".

- [ ] **Schritt 6: Trockenlauf**

```bash
/usr/bin/python3 build-agents-md.py --dry-run
```
Erwartet: die acht geänderten Agenten in der Vorschau, keine offenen Platzhalter.

- [ ] **Schritt 7: Anwenden und verifizieren**

```bash
/usr/bin/python3 build-agents-md.py --apply
/usr/bin/python3 build-agents-md.py --verify
```
Erwartet: `VERIFY OK`.

`--verify` prüft nur Strukturmarker, nicht den Inhalt. Deshalb zusätzlich:
```bash
grep -c "Wert | Bereich" roles/*.role.md | grep -v ":0"
```
Erwartet: sieben Dateien mit je einem Treffer.

- [ ] **Schritt 8: Am lebenden Agenten prüfen**

Einen CTO-Lauf anstoßen, der eine Mail an Walter schickt. Erwartet: Signatur kommt einfach vor, der Agent setzt keine eigene Grußformel darunter.

- [ ] **Schritt 9: Committen**

`~/.paperclip/scripts/agents-instructions/` ist **kein** Repository — hier gibt
es nichts zu committen. Das Sicherungsnetz ist das Backup aus Schritt 1. Zum
Abschluss prüfen, dass es existiert und den Vor-Zustand enthält:

```bash
ls -lt ~/.paperclip/scripts/agents-instructions/backups/ | head -3
```
Erwartet: als neuestes das Backup von heute, angelegt in Schritt 1.

---

## Nach Abschluss zu melden

- **sorbART ist stillgelegt.** Luna kann den Bereich nicht mehr wählen; Mails
  von `@sorbart.de` und `@sorbart.shop` laufen jetzt in die Rückfrage-Regel.
  Falls dort noch etwas ankommt, braucht es eine Entscheidung, welcher Bereich
  gilt.
- **Der offene SORBART-Vorgang** in der Freigabe-Queue wurde storniert
  (Aufgabe 3, Schritt 1) — oder vorher freigegeben, je nach Walters Antwort.
- **FILM-Lorbeerbanner** bewusst nicht enthalten (749 KB). Falls gewünscht,
  nur für Lunas Kundenpfad nachrüsten.
- **`paperclip@clara-werden.de`** bleibt unsigniert — eigener Mandant ohne
  Branding im `Signatures`-Ordner.
- **`health@`** trägt AI-Branding, weil für Health Insights kein eigenes
  vorliegt.
- **Doppelte Logik** in `signatur.py` und `relay_signatur.js` ist bewusst: n8n
  führt JavaScript aus, Luna braucht Python für die Vorschau. Der Abgleich in
  Aufgabe 4, Schritt 5 hält beide zusammen; bei Änderungen beide anfassen.
