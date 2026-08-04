# Bild-, 360°- und Video-Aufträge an den CEO

**Stand:** 2026-08-04, abends · geprüft gegen den laufenden Bilddienst, die Live-Instruktionen der Agenten und den Renderknoten. Bild→Bild ist seit heute Abend bestellbar und am Knoten mit zwei Läufen belegt.

Diese Anleitung beschreibt, wie du Bildaufträge in die Firma gibst — was der
CEO daraus macht, welche Formulierungen funktionieren und wo die Kette heute
noch endet.

---

## 1. Kurzfassung: was heute wirklich geht

| Was du willst | Bestellbar? | Wie | Dauer |
|---|---|---|---|
| **Text → Bild** (flach) | **ja** | `modell: qwen` (lokal) oder `modell: openai` | ~14 s / ~20 s |
| **Text → 360°-Panorama** | **ja** | `modell: qwen360` | ~5–6 min |
| **Bild → Bild** (Variante, Retusche, Kombination) | **ja** | `modell: qwenedit`, ein bis drei Bildanhänge | ~2–3 min |
| **Text → Video** | **nein** | LTX-2.3 läuft, aber nur von Hand auf dem Knoten | ~3 min Rechnen, ~41 min Kaltstart |
| **Bild → Video** | **nein** | dito (LTX kann `--image`, ist nicht angeschlossen) | — |
| 360°-Video | **nein** | kein produktionsreifes freies Modell | — |

Alles unter „nein" ist in Abschnitt 6 im Detail erklärt — inklusive dem, was
jeweils fehlt.

---

## 2. Die drei Wege, einen Auftrag abzusetzen

### Weg A — Paperclip-Oberfläche (empfohlen für alles Größere)

<http://localhost:3100> → neues Issue → **Assignee: CEO**.
Der CEO triagiert, delegiert und aggregiert. Das ist der Weg, wenn das Bild
Teil einer größeren Sache ist („Social-Post zum Thema X, mit Bild").

### Weg B — Telegram an Jarvis

`@whitestag_jarvis_bot`, Text oder Sprachnachricht. Jarvis erkennt an deiner
Formulierung, ob es eine Aufgabe ist, und legt daraus **ein Issue beim CEO**
an. Du bekommst `✅ Task angelegt: WHI-xxxx` zurück.

Damit Jarvis es als Auftrag versteht und nicht als Frage: **imperativ
formulieren.** „Lass ein Bild erstellen von …" statt „Kannst du …?"

### Weg C — Sprache am Studio

„Hey Jarvis" → Auftrag diktieren. Gleicher Weg wie B, nur ohne Telefon.
Bei Diktat gilt: **Fachbegriffe wie „equirektangular" verschluckt Whisper
gern.** Sag stattdessen „Rundumblick" oder „360-Grad-Panorama".

### Weg D — Abkürzung: direkt beim Bilddienst bestellen

Brauchst du **nur** ein Bild und keine Firmenleistung drumherum, kannst du den
CEO überspringen. Der Bilddienst pollt jede Minute **alle** Issues mit dem
Label `bild` in Status `todo` oder `backlog` — unabhängig davon, wem sie
zugewiesen sind.

Also: Issue anlegen, Label **`bild`** setzen, den Brief (Abschnitt 3) in die
**Beschreibung**, fertig. Nach spätestens einer Minute läuft der Render, das
PNG hängt danach als Anhang am Issue und das Issue steht auf `done`.

Das ist der schnellste und verlässlichste Weg für ein einzelnes Bild.

---

## 3. Text → Bild

### Was du dem CEO sagst

> Ich brauche ein Titelbild für den Blogartikel über KI-Videoproduktion.
> Querformat, fotorealistisch, ein Schnittplatz mit zwei Monitoren im
> Halbdunkel, warmes Licht von der Seite. Lass es vom Bilddienst rendern.

Mehr braucht es nicht. Der CEO kennt den Bilddienst und legt daraus einen
Subtask mit Label `bild` an. Du musst ihm weder Modellnamen noch Format
nennen — aber wenn du es tust, übernimmt er es.

### Was der CEO daraus baut (und was du bei Weg D selbst schreibst)

Subtask mit Label `bild`, in der Beschreibung genau dieses Format —
**eine Angabe pro Zeile, `schlüssel: wert`:**

```
prompt: Ein Schnittplatz mit zwei Monitoren im Halbdunkel, warmes Seitenlicht,
        fotorealistisch, flache Schärfentiefe
modell: qwen
format: 1536x1024
seed: 42
```

| Feld | Pflicht | Werte | Standard |
|---|---|---|---|
| `prompt` | **ja** | Freitext | — (fehlt er, wird der Auftrag abgebrochen) |
| `modell` | nein | `qwen`, `qwen360`, `openai` | `qwen` |
| `format` | nein | `1024x1024`, `1024x1536`, `1536x1024`, `1344x768`, `768x1344` | `1024x1024` |
| `seed` | nein | 0 … sehr groß | zufällig |
| `quality` | nur bei `openai` | `low`, `medium`, `high`, `auto` | `medium` |
| `transparent` | nur bei `openai` | `true` / `false` | `false` |

Ungültige Werte werden **stillschweigend auf den Standard zurückgesetzt** —
ein Tippfehler bei `modell:` liefert dir also ein normales Bild statt einer
Fehlermeldung. Der Abschlusskommentar nennt immer, was tatsächlich gelaufen
ist; da lohnt der Blick.

### `qwen` oder `openai`?

**`qwen` ist der Standard und die richtige Wahl.** Läuft lokal auf dem
MacBook-Renderknoten, kostet nichts, ~14 s pro Bild, 60 Bilder pro Tag.

**`openai`** (gpt-image-1) nur, wenn du etwas brauchst, das das lokale Modell
nicht kann — vor allem **Text im Bild** und **transparenter Hintergrund**.
Es kostet echtes Geld und läuft gegen ein hartes Budget: 15 Bilder/Tag,
4,50 USD/Monat. Ist das Budget erschöpft, wird der Auftrag `cancelled` mit
Kommentar.

### Reproduzieren und variieren

Der verwendete `seed` steht im Abschlusskommentar. Gleicher Prompt + gleicher
Seed = dasselbe Bild. Für Varianten: Seed weglassen (dann würfelt der Dienst)
oder gezielt hochzählen.

---

## 4. Text → 360°-Panorama

### Was du dem CEO sagst

> Ich brauche ein 360-Grad-Panorama als Hintergrund für die VR-Szene:
> ein leerer Konzertsaal am Vormittag, Sonnenlicht durch hohe Fenster,
> fotografisch. Bilddienst, qwen360.

### Der Brief

```
prompt: Ein leerer Konzertsaal am Vormittag, Sonnenlicht fällt durch hohe
        Fenster auf rote Sitzreihen, Fotografie
modell: qwen360
format: 2048x1024
```

Ergebnis: ein equirektangulares Panorama im Seitenverhältnis 2:1, direkt in
jedem 360-Viewer oder VR-Headset betrachtbar. Andere Formate als 2048×1024
(erlaubt wären noch 1536×768 und 1024×512) verschlechtern das Ergebnis —
das Modell ist auf 2048×1024 trainiert.

### Fünf Regeln, die den Unterschied machen

1. **Schreib „equirectangular" NICHT in den Prompt.** Das Auslösewort steht
   bereits in der Workflow-Vorlage. Doppelt gemoppelt schadet hier.
2. **Beschreibe den Raum, nicht den Bildausschnitt.** Es gibt keinen Rand und
   keinen Blickwinkel — was du beschreibst, umgibt den Betrachter vollständig.
   „Im Vordergrund links" und „Nahaufnahme" laufen ins Leere.
3. **Nenne den Stil** (Fotografie, Ölgemälde, Illustration). Das verbessert
   das Ergebnis deutlich.
4. **Bei Personen: Kopf/Gesicht und Schuhwerk ausdrücklich erwähnen.** Sonst
   werden Ganzkörperfiguren oben oder unten abgeschnitten oder verzerrt.
5. **Nicht mehrere gleichzeitig bestellen.** Ein Panorama braucht 5–6 Minuten
   statt 15 Sekunden.

### Die Naht

Auf großen, gleichmäßig hellen Flächen (Himmel, glatter Boden) bleibt an der
Nahtstelle eine feine vertikale Linie erkennbar. In dunklen und texturierten
Bereichen ist sie verschwunden. Für Skybox- und Hintergrundzwecke ist das
tragbar — wenn du sie ganz weghaben willst, ist das ein zweiter Arbeitsschritt
(Seam-Mask + Inpainting), den es heute noch nicht als Auftrag gibt.

### Nebenwirkung bei gemischten Stapeln

Der Knoten kann die beiden 19-GB-Modelle nicht gleichzeitig vorhalten.
Wechselst du zwischen normalen Bildern und Panoramen, kommt jedes Mal ein
Nachladen dazu — das Normalbild direkt nach einem 360-Lauf brauchte gemessen
76 s statt 18 s. Kein Fehler, aber einplanen: **erst alle Panoramen, dann alle
Normalbilder**, nicht abwechselnd.

---

## 4a. Bild → Bild

### Was du dem CEO sagst

> Ich hänge dir zwei Bilder an: das Produktfoto und die Studioszene. Lass das
> Produkt in die Szene setzen, Licht von links, Rest der Szene unverändert.

### Der Brief

Wie ein normaler Bildauftrag — mit **einem bis drei Bildanhängen am Issue**:

```
prompt: Ersetze die blaue Kugel in Bild 1 durch die orangefarbene Kugel
        aus Bild 2, behalte den Schriftzug darunter
modell: qwenedit
seed: 7
```

**„Bild 1" ist der zuerst angehängte.** Bei nur einem Anhang brauchst du gar
keinen Verweis — dann genügt „entferne die Person im Hintergrund".

**Kein `format:`.** Die Ausgabegröße folgt dem ersten Quellbild. Gibst du
trotzdem eines an, wird es ignoriert und im Kommentar vermerkt — nicht
stillschweigend verworfen.

### Vier Dinge, die den Unterschied machen

1. **Sag, was bleiben soll**, nicht nur was sich ändert. „Ersetze die Kugel,
   **behalte den Schriftzug darunter**" trifft zuverlässiger als „ersetze die
   Kugel".
2. **Beziehe dich ausdrücklich auf die Bildnummern**, sobald es mehr als eines
   ist. Ohne Verweis rät das Modell, welches Bild die Vorlage und welches die
   Änderung ist.
3. **Schrift bleibt heikel.** Vorhandene Schrift im Bild übersteht die
   Bearbeitung meist, wird aber an den Rändern unsauber. Bei Text, auf den es
   ankommt: Bild ohne Text bearbeiten lassen und die Typografie hinterher
   setzen.
4. **Nicht mit normalen Bildern mischen.** Der Knoten kann das 41-GB-Edit-Modell
   und das normale nicht gleichzeitig vorhalten; jeder Wechsel kostet Ladezeit.
   Erst alle Edit-Aufträge, dann alle normalen.

### Fehlerfälle

| Fall | Was passiert |
|---|---|
| kein Bildanhang | Abbruch mit Hinweis — der Dienst kann nicht raten, was du bearbeiten willst |
| mehr als drei Bilder | Abbruch. Bewusst kein stillschweigendes Kürzen: sonst meint „Bild 2" etwas anderes, als du siehst |
| Anhang über 20 MB | Abbruch mit Größenangabe |
| PDF/XLSX am Issue | wird ignoriert, zählt nicht als Bild |

### Gemessen am 04.08.

| Lauf | Dauer |
|---|---|
| ein Quellbild, kalt (inkl. Laden der 41 GB) | 180 s |
| zwei Quellbilder, warm | 120 s |
| normales Bild danach (Modell-Rückwechsel) | 51 s statt 14 s |

Belegt ist außerdem, dass der Edit-Pfad die **normalen Bilder nicht
verändert**: derselbe Auftrag mit festem Seed lieferte vor und nach einem
Edit-Lauf ein bitgleiches PNG.

## 5. Was du dem CEO zusätzlich mitgeben solltest

Der Bilddienst kennt nur den Prompt — Marke, Zweck und Zielformat kennt er
nicht. Diese Dinge gehören deshalb in **deinen** Auftrag an den CEO, damit er
sie in den Prompt übersetzt:

- **Wofür** — LinkedIn-Post, Blog-Header, Angebotsdeckblatt, VR-Skybox.
  Daraus leitet er Format und Bildsprache ab.
- **Stil** — fotorealistisch, illustrativ, technisch/diagrammartig.
- **Was auf keinen Fall** — keine Menschen, keine Schrift, kein Logo.
- **Wie viele Varianten** — sonst bekommst du genau eine.

**Schrift im Bild:** Das lokale Modell schreibt unzuverlässig. Willst du
Text im Bild, entweder `modell: openai` oder — besser — Bild ohne Text
bestellen und die Typografie hinterher setzen lassen (Adobe-Agent /
Web-Design).

---

## 6. Was heute nicht bestellbar ist

Damit du nicht auf etwas wartest, das nicht kommt.

### Text → Video und Bild → Video

**Nicht bestellbar.** LTX-2.3 ist auf dem Renderknoten eingerichtet und
funktioniert — der erste Testclip (704×448, 4 Sekunden, 24 fps, **mit
synchronem Ton**) sieht überzeugend aus: kohärente Kamerafahrt, stabile
Personen und Beleuchtung. Auch Bild→Video kann die CLI (`--image`), ebenso
Keyframe-Interpolation zwischen zwei Bildern.

Was fehlt, ist die Anbindung — und zwar aus einem konkreten Grund:

| Abschnitt | Zeit |
|---|---|
| Rechnen (Denoising, zwei Stufen) | ~3:13 |
| **Wanduhr gesamt** | **41:28** |

Die restlichen ~38 Minuten sind reines **Laden der Gewichte**: die CLI liest
bei jedem Aufruf über 20 GB frisch von der Platte. Ein Video-Auftrag als
Ein-Schuss-Aufruf wäre damit unbrauchbar. Video braucht einen **residenten
Prozess**, der die Gewichte einmal lädt — so wie ComfyUI es für Bilder tut.
Dann liegt ein Clip bei drei bis vier Minuten.

**Wenn du jetzt einen Clip brauchst:** als Einzelstück von Hand auf dem Knoten
rendern lassen — sag es mir, dann mache ich das. Nicht als Serie: jeder Clip
kostet dann 40 Minuten.

**Warum LTX und nicht Wan oder Hunyuan:** HunyuanVideo scheidet aus
Lizenzgründen aus (die Tencent-Lizenz schließt die EU ausdrücklich aus),
Wan 2.2 hat die sauberste Lizenz, ist auf Apple Silicon aber unbrauchbar
langsam. LTX ist frei für Firmen unter 10 Mio. $ Umsatz und läuft nativ auf
Metal.

### 360°-Video und Stereoskopie

Kein produktionsreifes freies Modell. Zurückgestellt.

---

## 7. Grenzen, Kosten, Wartezeiten

| Grenze | Wert | Was passiert beim Überschreiten |
|---|---|---|
| Lokale Bilder / Tag | 60 | Auftrag wird `cancelled`, Kommentar „morgen erneut" |
| OpenAI-Bilder / Tag | 15 | dito |
| OpenAI-Budget / Monat | 4,50 USD | dito, mit Angabe des Verbrauchs |
| Gleichzeitige Renders | 3 | Auftrag wartet, einmaliger Kommentar „Warteschlange voll" |
| Zeitlimit normales Bild | 300 s | ein automatischer zweiter Versuch, dann Abbruch + Alarmmail |
| Zeitlimit 360° | 900 s | dito |
| Zeitlimit Bild→Bild | 600 s | dito |
| Quellbilder je Auftrag | 1–3, je ≤ 20 MB | Abbruch mit Hinweis |
| Poll-Takt des Dienstes | 60 s | — |

Der Dienst bedient alle drei Firmen (WHITESTAG, Clara, Health) aus derselben
Warteschlange — die Limits gelten **gemeinsam**.

---

## 8. Wenn nichts passiert

Der Reihe nach:

1. **Steht das Label `bild` am Issue?** Ohne Label sieht der Dienst es nicht.
   Der Dienst pollt ausschließlich `todo` und `backlog` — ein Issue in
   `in_progress` wird nicht abgeholt.
2. **Ist eine Zeile `prompt: …` in der Beschreibung?** Ohne Prompt bricht der
   Dienst ab und kommentiert das Format.
3. **Steht ein Kommentar am Issue?** Der Dienst meldet jeden Abbruch mit
   Grund. „Warteschlange voll" heißt: warten. „Renderknoten nicht erreichbar"
   heißt: das MacBook (192.168.2.40) ist aus oder ComfyUI läuft nicht.
4. **Ist der CEO überhaupt handlungsfähig?** Er steht aktuell auf `error` —
   ein Agent in diesem Zustand nimmt keine neuen Aufträge an. Das ist ein
   bekanntes Muster (Agenten finden nach einer LLM-Störung nicht von selbst
   zurück). Kurzfristige Abhilfe: Weg D nutzen (direkt `bild`-Issue) oder mir
   Bescheid geben.
5. **Logs:** `~/.paperclip/instances/default/state/bild-service.out.log`
   und `.err.log`.

Bei echten Störungen (Knoten seit >30 Minuten weg, Auftrag hängengeblieben)
schickt der Dienst von sich aus eine Mail an ws@whitestag.ai.

---

## 9. Was beim Schreiben dieser Anleitung aufgefallen ist

### Behoben am 04.08.: fünf Agenten delegierten ins Leere

Der Agent **„Bild & Video"** (`f4bf1c83-…`) ist seit einiger Zeit
`terminated` — fünf Rollen wiesen ihm aber weiterhin die KI-Bild- und
KI-Video-Erzeugung zu: **Adobe, Creative Director, CTO, CMO, CPO**. Ein
Subtask an einen beendeten Agenten wird nie geweckt und bleibt für immer
offen. Zusätzlich nannten diese Texte Modelle, die es hier nie gab
(FLUX schnell/dev/2, Wan 2.2, HunyuanVideo).

Korrigiert in den Rollen-Quellen (`~/.paperclip/scripts/agents-instructions/roles/`)
und über den Generator ausgerollt: alle fünf zeigen jetzt auf den
`bild`-Label-Weg mit den tatsächlichen Modellen (`qwen`, `qwen360`,
`openai`), halten fest, dass KI-Video derzeit nicht bestellbar ist, und
warnen ausdrücklich vor dem toten Agenten. Der beendete Agent ist außerdem
aus `agents-manifest.json` entfernt, damit der Generator nicht länger für
ihn schreibt.

### Offen: drei verwaiste Instruktions-Ordner

Unter `~/.paperclip/instances/default/companies/9cebf3cf…/agents/` liegen
**30 Ordner für 27 aktive Agenten**. Drei gehören zu gelöschten Agenten
(u. a. ein „Lektor", der mit dem heutigen „Lektorat" nichts zu tun hat) und
enthalten veraltete Instruktionen — unter anderem den Bild-Block ohne 360°.
Sie werden nicht ausgeliefert und richten keinen Schaden an, führen bei
`grep` über den Ordner aber zu falschen Schlüssen. Aufräumen lohnt.

### Offen: ein Agent hängt nicht am Generator

Der **n8n-Betriebsingenieur** (`dfa8d0e2-…`) ist live, steht aber nicht im
Manifest. Seine `AGENTS.md` ist handgepflegt und bekommt deshalb keinen der
gemeinsamen Blöcke — auch nicht „Bild/Grafik bestellen". Für seine Aufgabe
(n8n-Recovery) unkritisch, aber gut zu wissen, bevor jemand sich wundert.

---

## Referenzen

- Bilddienst: `~/.paperclip/scripts/bild-service/` (launchd `de.whitestag.bild-service`, 60-s-Takt)
- Renderknoten: MacBook M5 Max, `192.168.2.40`, ComfyUI auf Port 8189
- Label `bild`: WHITESTAG `9433325a-fa6e-43c2-bb09-b077a01843de` · Clara `f8212203-db94-4c20-9922-0078289e874e` · Health `36ad26e6-4ed8-4ac3-8f43-28c8600a1ab1`
- CEO WHITESTAG: `506c873e-3a40-4483-9a45-0eb0fa1554bb`
- Technische Details 360°/Video: [`specs/2026-08-03-360-panorama-und-video.md`](specs/2026-08-03-360-panorama-und-video.md)
- Bilddienst-Design: [`specs/2026-08-02-comfyui-bild-renderer-design.md`](specs/2026-08-02-comfyui-bild-renderer-design.md)
