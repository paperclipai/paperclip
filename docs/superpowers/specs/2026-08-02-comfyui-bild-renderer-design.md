# ComfyUI als lokaler Bild-Renderer für Paperclip-Agenten

**Datum:** 2026-08-02
**Status:** Design freigegeben, Umsetzung offen
**Nachfolge-Spec:** Video-Rendering (LTX / Hunyuan) auf derselben Infrastruktur — separat, später

## Ausgangslage

Agenten bestellen Bilder heute über einen Subtask mit dem Label `bild:openai`.
Der launchd-Dienst `de.whitestag.bild-service` pollt im 60-Sekunden-Takt, liest
`prompt:` / `size:` / `quality:` aus der Beschreibung, ruft OpenAIs `gpt-image-1`
und hängt das PNG ans Issue. Grenzen: 15 Bilder pro Tag, 4,50 USD pro Monat.

Der Weg wird kaum genutzt — seit dem 15.06.2026 wurde genau ein Bild erzeugt.

ComfyUI Desktop ist auf beiden Macs installiert. Auf dem Mac Studio (seit
27.04.2026, v0.8.36, MPS) liegen ausschließlich Video-Modelle: LTX-Video 2b
(5,9 GB) und Hunyuan-Video t2v 720p Q8 (13 GB). Ein Bild-Checkpoint existiert
nirgends.

## Ziele

1. **Kosten und Limits weg** — lokales Rendern ohne Tages- und Monatsdeckel
2. **Datenschutz** — Prompts und Referenzmaterial verlassen das Haus nicht
3. **Kontrolle über den Look** — eigene Workflows, feste Seeds, Wiederholbarkeit
4. Video als Fernziel — die Infrastruktur muss es tragen, diese Spec baut es nicht

## Entscheidungen

### Renderknoten: MacBook M5 Max (192.168.2.40)

Beide Macs laufen 24/7 mit je 128 GB. LM Studio belegt auf dem Studio rund
63 GB (qwen3.6-35b, qwen3-coder-30b, gemma-4-12b, bge-m3), auf dem MacBook rund
39 GB (gemma-4-31b, openbiollm). Der Studio bleibt Paperclip- und Agenten-Host,
das MacBook wird reiner Renderknoten. RAM-Konkurrenz zwischen Render und
LLM-Inferenz hat bereits zweimal Fehlerwellen ausgelöst; die Trennung vermeidet
das Muster.

### Headless statt Desktop-App

ComfyUI Desktop ist eine Electron-App — der API-Server lebt nur, solange das
Fenster offen ist. Ein Agent, der nachts um 03:00 ein Bild bestellt, liefe ins
Leere. Die App bringt aber alles mit, was für einen Serverbetrieb nötig ist:
`main.py` unter `/Applications/ComfyUI.app/Contents/Resources/ComfyUI/` und eine
venv mit torch 2.11 und funktionierendem MPS unter `~/Documents/ComfyUI/.venv/`.

LaunchAgent `de.whitestag.comfyui-node` auf dem MacBook:

```
~/Documents/ComfyUI/.venv/bin/python \
  /Applications/ComfyUI.app/Contents/Resources/ComfyUI/main.py \
  --listen 0.0.0.0 --port 8189 --base-directory ~/Documents/ComfyUI
```

`RunAtLoad`, `KeepAlive`, Logs nach `~/Library/Logs/comfyui-node.{out,err}.log`.
Gesundheitsprüfung über `GET /system_stats`.

**Port 8189, nicht 8188.** Belegt der Dienst den Standardport, startet die
Desktop-App daneben nicht mehr — sie will ihren eigenen Server hochziehen. Auf
8189 bleibt die App zum Bauen und Exportieren von Workflows nutzbar; genau dafür
wird sie gebraucht.

**Kein Auth.** ComfyUI hat keine Authentifizierung. Mit `--listen 0.0.0.0` kann
jeder im LAN Aufträge einstellen. Für das Heimnetz bewusst akzeptiert. Falls
später nötig: macOS-Firewall auf die Studio-IP einschränken.

### Modelle: FLUX.1 [schnell] und Qwen-Image, beide Apache 2.0

Bilder landen in Kundendeliverables, deshalb ist die Modellwahl eine
Lizenzfrage.

| Modell | Lizenz | Größe (fp8) | Einsatz |
|---|---|---|---|
| FLUX.1 [schnell] | Apache 2.0 | ~17 GB | Standard, 4 Steps, Sekunden pro Bild |
| Qwen-Image | Apache 2.0 | ~29 GB inkl. Text-Encoder + VAE | Schrift im Bild, Minuten pro Bild |
| FLUX.1/2 [dev] | nicht-kommerziell | — | **ausgeschlossen** |

FLUX.1 [dev] und FLUX.2 [dev] erlauben kommerzielle Nutzung nur über die
BFL-API oder eine gekaufte Self-Hosting-Lizenz und scheiden damit aus.

Zusammen rund 46 GB Download auf das MacBook.

### Kein Cloud-Fallback

Ist der Knoten nicht erreichbar, bleibt der Auftrag liegen und wird erneut
versucht. Kein automatischer Rückfall auf OpenAI — ein stiller Cloud-Upload
widerspräche dem Datenschutzziel. OpenAI bleibt erreichbar, aber nur, wenn ein
Agent es im Brief ausdrücklich anfordert.

### Architektur: Renderer im bestehenden Dienst

Der Bild-Dienst wird um ein Renderer-Modul erweitert statt durch einen zweiten
Dienst ergänzt. Paperclip-Client, Token-Behandlung, Attachment-Upload,
Mail-Alarm und flock-Guard existieren und sind erprobt; ein Parallel-Dienst
würde sie duplizieren, und Duplikate driften — Deploy-Drift hat hier schon
mehrfach Dienste stillgelegt.

Verworfen wurde außerdem der direkte Werkzeugzugriff der Agenten auf ComfyUI:
ein Qwen-Render dauert Minuten und läuft in jeden Agenten-Timeout, und die
lokalen LM-Studio-Agenten erreicht nur `AGENTS.md` — sie haben kein
verlässliches Werkzeug-Framework. Warteschlange und Wiederholung müssten neu
gebaut werden.

## Komponenten

Alle unter `~/.paperclip/scripts/bild-service/`.

### `comfy_client.py` — HTTP-Anbindung an den Knoten

Kennt nur ComfyUI, nichts von Paperclip.

- `health()` → bool, über `GET /system_stats`
- `submit(workflow: dict)` → `prompt_id`, über `POST /prompt`
- `poll(prompt_id)` → `("running" | "done" | "error", nutzlast)`, über
  `GET /history/<prompt_id>`
- `fetch_image(filename, subfolder, type)` → PNG-Bytes, über `GET /view`

### `workflow_template.py` — Vorlagen füllen

Lädt eine Vorlage aus `workflows/` und ersetzt die Platzhalter `__PROMPT__`,
`__SEED__`, `__WIDTH__`, `__HEIGHT__`.

Die Vorlagen liegen im **ComfyUI-API-Format** (`Save (API Format)`), nicht im
normalen UI-Export — die Strukturen unterscheiden sich, das ist die häufigste
Fehlerquelle. Platzhalter statt Node-IDs, damit ein in der Desktop-App
umgebauter und neu exportierter Workflow ohne Codeänderung weiterläuft.

- `workflows/flux-schnell.api.json`
- `workflows/qwen-image.api.json`

### `job_state.py` — Warteschlange über Neustarts hinweg

Erweitert die bestehende State-Datei
`~/.paperclip/instances/default/state/bild-service.json` um einen Abschnitt
`jobs`: Issue-ID → `{prompt_id, modell, company_id, abgesendet_am, versuche}`.
Die bestehende Tageskosten-Struktur bleibt unverändert daneben stehen.

- `add`, `all`, `drop`, `bump_attempt`
- `age_seconds(job)` für die Zeitüberschreitung

### `brief_parser.py` — erweitert

Neue Felder `modell`, `seed`; `format` löst `size` ab. Ungültige Werte fallen
auf den Standard zurück, statt den Auftrag scheitern zu lassen.

### `bild_service.py` — zwei Phasen statt einer

Weiterhin 60-Sekunden-Takt, weiterhin flock-Single-Instance.

1. **Einsammeln** — für jeden offenen Auftrag `poll()`. Fertig → PNG holen, als
   Attachment ans Issue, Abschlusskommentar, Status `done`, Auftrag entfernen.
2. **Absenden** — neue Issues mit Bild-Label ohne laufenden Auftrag → Brief
   parsen, Vorlage füllen, `submit()`, `prompt_id` merken.

Höchstens **drei Aufträge gleichzeitig** unterwegs. Sonst tauscht ComfyUI
dauernd zwischen Flux und Qwen die Modelle im Speicher, und der Wechsel kostet
mehr Zeit als der Render.

Der OpenAI-Pfad (`openai_image.py`) bleibt synchron und unverändert.

## Auftragsformat

```
prompt: Ein Hirsch im Nebel, fotorealistisch, kaltes Morgenlicht
modell: schnell          # schnell (Standard) | qwen | openai
format: 1536x1024        # Standard 1024x1024
seed: 42                 # optional, sonst zufällig
```

**`modell`** — Standard `schnell`: lokal, kostenlos, ohne Deckel. `qwen`, wenn
Schrift im Bild stehen soll. `openai` ist ab jetzt die bewusste Ausnahme und
läuft weiter unter 15 Bildern pro Tag und 4,50 USD pro Monat.

**`seed`** — ohne Angabe zufällig, aber der verwendete Seed steht *immer* im
Abschlusskommentar. Damit kann ein Agent ein gelungenes Bild gezielt variieren
statt neu zu würfeln. Mit der OpenAI-API ist das grundsätzlich nicht möglich.

**`format`** — Positivliste: 1024×1024, 1024×1536, 1536×1024, 1344×768,
768×1344. Ohne Liste fordert irgendwann ein Agent 4096×4096 an und belegt den
Knoten eine halbe Stunde.

Die letzten beiden Formate kennt die OpenAI-API nicht. Bei `modell: openai`
wird deshalb auf das nächstliegende erlaubte Format abgebildet — 1344×768 →
1536×1024, 768×1344 → 1024×1536 — und die Abweichung im Abschlusskommentar
genannt. Der Auftrag scheitert daran nicht.

**`quality`** gilt nur auf dem OpenAI-Pfad; für die lokalen Modelle ist es
bedeutungslos und wird ignoriert. Umgekehrt gilt **`seed`** nur lokal — die
OpenAI-API nimmt keinen Seed entgegen. Wird beides gesetzt, wird das jeweils
unwirksame Feld stillschweigend übergangen; der Abschlusskommentar nennt immer
nur die tatsächlich verwendeten Einstellungen.

### Label-Umbenennung

`bild:openai` → `bild`, in allen drei Companies. Ein Eintrittspunkt, das Modell
steht im Brief.

| Company | Company-ID | Label-ID |
|---|---|---|
| WHITESTAG | `9cebf3cf-efe8-4597-a400-f06488900a87` | `9433325a-fa6e-43c2-bb09-b077a01843de` |
| Clara | `0e426844-309c-4528-9aa5-90ff76790a51` | `f8212203-db94-4c20-9922-0078289e874e` |
| Health | `158c4959-4973-4cb0-8066-55ec0f35625e` | `36ad26e6-4ed8-4ac3-8f43-28c8600a1ab1` |

Die Label-IDs bleiben, nur der Name ändert sich — der Dienst filtert ohnehin
über die ID. Agenten sprechen das Label aber über den Namen an, deshalb müssen
die Instruktionen mitgezogen werden, und zwar in der Generator-Quelle
(`roles/*.role.md`). `AGENTS.md` wird nachts überschrieben und ist kein
gültiger Ablageort.

## Fehlerbehandlung

**Knoten nicht erreichbar** — Zyklus überspringen, Zähler für aufeinander
folgende Fehlversuche erhöhen. Bei 30 in Folge (30 Minuten) *einmal* ein
Kommentar an jedem betroffenen Issue — also jedem mit Bild-Label in `todo` oder
`backlog`, dessen Auftrag deshalb liegen bleibt — plus *eine* Mail an
ws@whitestag.ai. Zähler bei Erfolg zurücksetzen. Kein Spam, aber keine stille
Warteschlange.

**Auftrag hängt** — schnell über 10 Minuten, qwen über 45 Minuten: ein
Wiederholungsversuch mit neuer `prompt_id`. Beim zweiten Mal Kommentar, Status
`cancelled`, Mail.

**ComfyUI meldet Ausführungsfehler** — Kommentar mit der Node-Fehlermeldung,
Status `cancelled`, **kein** Wiederholungsversuch. Ein kaputter Prompt oder ein
fehlendes Modell repariert sich nicht durch Wiederholen.

**Brief unvollständig** — wie bisher: Kommentar mit Formatbeispiel, Status
`cancelled`.

**Paperclip-Token abgelaufen** — wie bisher: `AuthError` → Mail, Dienst beendet
sich.

**Amoklauf-Bremse** — höchstens 60 lokale Bilder pro Tag. Lokal kostet nichts,
aber ein Agent in einer Schleife würde den Knoten sonst dauerhaft belegen;
Run-Stürme sind hier ein bekanntes Muster. Zähler getrennt vom
OpenAI-Kostenzähler.

## Tests

pytest neben den Modulen, wie im Dienst bereits üblich.

- `test_brief_parser.py` (erweitert) — neue Felder, Standardwerte, ungültige
  Werte fallen zurück statt zu scheitern
- `test_workflow_template.py` — jede Vorlage enthält alle vier Platzhalter;
  nach der Substitution bleibt keiner übrig und das Ergebnis ist gültiges JSON
- `test_comfy_client.py` — Antworten auf `/prompt` und `/history` (läuft /
  fertig / Fehler) gegen Fixtures parsen, `/view`-URL korrekt bauen; kein Netz
- `test_job_state.py` — Auftrag anlegen, einsammeln, Zeitüberschreitung,
  Wiederholung, Entfernen; Zustand übersteht einen Neustart
- `smoke_comfy.py` — manuelles Skript gegen den echten Knoten: ein 512er
  Testbild von Ende zu Ende. Läuft bei der Einrichtung, nicht in der Suite.

## Offene Punkte und Reihenfolge

1. **SSH-Zugang zum MacBook fehlt.** `ssh 192.168.2.40` scheitert mit
   `Permission denied (publickey,password,keyboard-interactive)`. Ohne ihn kann
   weder der LaunchAgent eingerichtet noch der Modell-Download angestoßen
   werden. Entweder Key hinterlegen oder diesen Schritt am Gerät selbst
   ausführen. **Das ist der erste Schritt der Umsetzung, alles andere hängt
   daran.**
2. **Freier Speicher auf dem MacBook unbekannt** — 46 GB Modelle müssen passen.
   Vor dem Download prüfen.
3. **Basisverzeichnis auf dem MacBook unbestätigt** — auf dem Studio ist es
   `~/Documents/ComfyUI`; auf dem MacBook nicht überprüfbar, weil kein
   SSH-Zugang. Beim Einrichten aus
   `~/Library/Application Support/ComfyUI/config.json` (`basePath`) auslesen.
4. **Video-Spec** — LTX und Hunyuan liegen auf dem Studio, nicht auf dem
   MacBook. Ob die Modelle umziehen oder ein zweiter Knoten entsteht, entscheidet
   die Video-Spec.

## Quellen

- [Can I Use FLUX for Commercial Use? — Civitai](https://civitai.com/articles/6625/can-i-use-flux-for-commercial-use)
- [Model Licenses and Restrictions — DeepWiki / black-forest-labs/flux](https://deepwiki.com/black-forest-labs/flux/5.1-model-licenses-and-restrictions)
- [FLUX.2 Pro and Dev FAQ: Licensing and API Use — Flowith](https://flowith.io/blog/flux-2-pro-dev-faq-licensing-lora-fine-tuning-api-rate-limits-self-hosting/)
- [Qwen-Image ComfyUI Native, GGUF, and Nunchaku Workflow Guide — ComfyUI Wiki](https://comfyui-wiki.com/en/tutorial/advanced/image/qwen/qwen-image)
- [Qwen Image ComfyUI: Generate and Edit Images (2026) — Thunder Compute](https://www.thundercompute.com/blog/qwen-image-edit-comfyui)
