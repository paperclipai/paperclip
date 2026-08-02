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

Auf dem MacBook M5 Max ist Comfy Desktop 2 mit ComfyUI 0.29.2 installiert, samt
Qwen-Image 2512 und Beschleuniger-LoRAs. Ein Messlauf am 02.08.2026 liefert ein
1024er Bild in **8,1 Sekunden**. Damit ist lokales Rendern nicht nur billiger,
sondern auch schneller als der Weg über die OpenAI-API.

## Ziele

1. **Kosten und Limits weg** — lokales Rendern ohne Tages- und Monatsdeckel
2. **Datenschutz** — Prompts und Referenzmaterial verlassen das Haus nicht
3. **Kontrolle über den Look** — eigene Workflows, feste Seeds, Wiederholbarkeit
4. Video als Fernziel — die Infrastruktur muss es tragen, diese Spec baut es nicht

## Bestandsaufnahme MacBook (geprüft am 02.08.2026)

| | |
|---|---|
| Zugang | `walterschonenbrocher@192.168.2.40`, Schlüssel `~/.ssh/id_ed25519` hinterlegt |
| Rechner | M4Max.fritz.box, 128 GB RAM, macOS 26.6, 2,4 TiB frei |
| Anwendung | Comfy Desktop 2 (`/Applications/Comfy Desktop.app`), ComfyUI 0.29.2 |
| ComfyUI-Quelle | `~/ComfyUI-Installs/ComfyUI/ComfyUI/main.py` |
| Python | `~/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python`, 3.13.12, torch 2.12.1, MPS |
| Modelle | `~/ComfyUI-Shared/models`, eingebunden über `shared_model_paths.yaml` |
| Ein-/Ausgabe | `~/ComfyUI-Shared/input`, `~/ComfyUI-Shared/output` |

**Falle:** Es gibt zwei Python-Umgebungen. Die naheliegende,
`~/ComfyUI-Installs/ComfyUI/standalone-env/`, enthält **kein torch** und ist
unbrauchbar. Nur die versteckte `.venv` innerhalb des ComfyUI-Quellordners
funktioniert. Das Manifest deklariert torch 2.12.1, installiert ist es
ausschließlich dort.

**Vorhandene Modelle** (rund 31 GB, nichts weiter herunterzuladen):

| Datei | Größe | Ordner |
|---|---|---|
| `qwen_image_2512_fp8_e4m3fn.safetensors` | 19 GB | `diffusion_models/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | 8,7 GB | `text_encoders/` |
| `qwen_image_vae.safetensors` | 242 MB | `vae/` |
| `Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16.safetensors` | 2,2 GB | `loras/` |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 810 MB | `loras/` |

## Entscheidungen

### Renderknoten: MacBook M5 Max (192.168.2.40)

Beide Macs laufen 24/7 mit je 128 GB. LM Studio belegt auf dem Studio rund
63 GB (qwen3.6-35b, qwen3-coder-30b, gemma-4-12b, bge-m3), auf dem MacBook rund
39 GB. Der Studio bleibt Paperclip- und Agenten-Host, das MacBook wird reiner
Renderknoten. RAM-Konkurrenz zwischen Render und LLM-Inferenz hat bereits
zweimal Fehlerwellen ausgelöst; die Trennung vermeidet das Muster.

### Headless statt Desktop-App

Comfy Desktop ist eine Electron-App — der API-Server lebt nur, solange das
Fenster offen ist, und lauscht dann auf `127.0.0.1:8188`, also **nur lokal**.
Vom Studio aus ist er nicht erreichbar, und ein Agent, der nachts um 03:00 ein
Bild bestellt, liefe ins Leere.

LaunchAgent `de.whitestag.comfyui-node` auf dem MacBook:

```
~/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python \
  ~/ComfyUI-Installs/ComfyUI/ComfyUI/main.py \
  --listen 0.0.0.0 --port 8189 \
  --extra-model-paths-config "$HOME/Library/Application Support/Comfy Desktop/shared_model_paths.yaml" \
  --input-directory  ~/ComfyUI-Shared/input \
  --output-directory ~/ComfyUI-Shared/output
```

`RunAtLoad`, `KeepAlive`, Logs nach `~/Library/Logs/comfyui-node.{out,err}.log`.
Gesundheitsprüfung über `GET /system_stats`.

**Port 8189, nicht 8188.** Auf 8188 liegt die Desktop-App. Auf 8189 bleibt sie
daneben nutzbar, und genau dafür wird sie gebraucht: neue Workflows baust du in
der GUI und exportierst sie als Vorlage für den Dienst.

**Betriebshinweis:** Rendern Desktop-App und Knoten gleichzeitig, liegen die
Modelle doppelt im Speicher — rund 28 GB je Instanz. Die App ist zum Bauen von
Workflows da, nicht zum Dauerbetrieb; wer sie nicht braucht, schließt sie.

**Kein Auth.** ComfyUI hat keine Authentifizierung. Mit `--listen 0.0.0.0` kann
jeder im LAN Aufträge einstellen. Für das Heimnetz bewusst akzeptiert. Falls
später nötig: macOS-Firewall auf die Studio-IP einschränken.

### Ein Modell: Qwen-Image 2512 mit Turbo-LoRA

Ursprünglich war FLUX.1 [schnell] als schneller Standard geplant und Qwen als
langsame Qualitätsstufe daneben. Der Messlauf hat diese Annahme widerlegt: Die
Turbo-LoRA bringt Qwen auf **2 Steps**, und damit ist es selbst der schnelle
Weg. Flux wären 17 GB zusätzlicher Download und eine zweite Workflow-Vorlage
ohne erkennbaren Gewinn. Es entfällt und kann jederzeit als zweite Vorlage
nachgerüstet werden, falls Tempo oder Bildsprache doch nicht genügen.

Damit gibt es lokal genau ein Modell, eine Vorlage und keinen Umschalter
zwischen lokalen Modellen.

Lizenz: Qwen-Image steht unter Apache 2.0 und ist kommerziell frei nutzbar.
FLUX.1 [dev] und FLUX.2 [dev] wären ohnehin ausgeschieden — nicht-kommerzielle
Lizenz, kommerzielle Nutzung nur über die BFL-API oder eine gekaufte
Self-Hosting-Lizenz. Die Lizenz der Turbo-LoRA ist noch zu prüfen (siehe Offene
Punkte).

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
die lokalen LM-Studio-Agenten erreicht nur `AGENTS.md`, sie haben kein
verlässliches Werkzeug-Framework, und Warteschlange samt Wiederholung müssten
neu gebaut werden.

## Messung (02.08.2026)

1024×1024, 2 Steps, cfg 1.0, euler/simple, `ModelSamplingAuraFlow` shift 3.1,
Turbo-LoRA bei Stärke 1.0, gegen die laufende Desktop-Instanz:

| Lauf | Dauer |
|---|---|
| kalt (Modelle von Platte) | 72,5 s |
| warm (Modelle im Speicher) | 8,1 s |

Ergebnisqualität geprüft: fotorealistisch, saubere Tiefenschärfe, korrekte
Anatomie. Für Agentenaufträge ohne Nacharbeit brauchbar.

Diese Zahlen setzen die Zeitüberschreitungen weiter unten.

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

Lädt `workflows/qwen-image.api.json` und ersetzt die Platzhalter `__PROMPT__`,
`__SEED__`, `__WIDTH__`, `__HEIGHT__`.

Die Vorlage liegt im **ComfyUI-API-Format**, nicht im normalen UI-Export — die
Strukturen unterscheiden sich, das ist die häufigste Fehlerquelle. Platzhalter
statt Node-IDs, damit ein in der Desktop-App umgebauter und neu exportierter
Workflow ohne Codeänderung weiterläuft.

Der Graph ist gegen `/object_info` der laufenden Instanz verifiziert:

| ID | Knoten | Wesentliche Eingaben |
|---|---|---|
| 1 | `UNETLoader` | `qwen_image_2512_fp8_e4m3fn.safetensors`, `default` |
| 2 | `CLIPLoader` | `qwen_2.5_vl_7b_fp8_scaled.safetensors`, Typ `qwen_image` |
| 3 | `VAELoader` | `qwen_image_vae.safetensors` |
| 4 | `LoraLoaderModelOnly` | Turbo-LoRA, Stärke 1.0 |
| 5 | `ModelSamplingAuraFlow` | shift 3.1 |
| 6 / 7 | `CLIPTextEncode` | `__PROMPT__` / leer |
| 8 | `EmptySD3LatentImage` | `__WIDTH__`, `__HEIGHT__` |
| 9 | `KSampler` | `__SEED__`, 2 Steps, cfg 1.0, euler, simple |
| 10 | `VAEDecode` | |
| 11 | `SaveImage` | Präfix `whitestag` |

### `job_state.py` — Warteschlange über Neustarts hinweg

Erweitert die bestehende State-Datei
`~/.paperclip/instances/default/state/bild-service.json` um einen Abschnitt
`jobs`: Issue-ID → `{prompt_id, company_id, abgesendet_am, versuche}`. Die
bestehende Tageskosten-Struktur bleibt unverändert daneben stehen.

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

Zwei Phasen, obwohl ein warmer Render nur 8 Sekunden dauert: ein kalter Start
kostet über eine Minute, und mehrere Aufträge hintereinander würden den
60-Sekunden-Takt sonst überziehen. Der Dienst wartet nie auf einen Render.

Höchstens **drei Aufträge gleichzeitig** unterwegs, damit ein einzelner Agent
den Knoten nicht monopolisiert.

Der OpenAI-Pfad (`openai_image.py`) bleibt synchron und unverändert.

## Auftragsformat

```
prompt: Ein Hirsch im Morgennebel, fotorealistisch, kaltes Gegenlicht
modell: qwen             # qwen (Standard) | openai
format: 1536x1024        # Standard 1024x1024
seed: 42                 # optional, sonst zufällig
```

**`modell`** — Standard `qwen`: lokal, kostenlos, ohne Deckel. `openai` ist die
bewusste Ausnahme und läuft weiter unter 15 Bildern pro Tag und 4,50 USD pro
Monat.

**`seed`** — ohne Angabe zufällig, aber der verwendete Seed steht *immer* im
Abschlusskommentar. Damit kann ein Agent ein gelungenes Bild gezielt variieren
statt neu zu würfeln. Mit der OpenAI-API ist das grundsätzlich nicht möglich.

**`format`** — Positivliste: 1024×1024, 1024×1536, 1536×1024, 1344×768,
768×1344. Ohne Liste fordert irgendwann ein Agent 4096×4096 an und belegt den
Knoten minutenlang.

Die letzten beiden Formate kennt die OpenAI-API nicht. Bei `modell: openai`
wird deshalb auf das nächstliegende erlaubte Format abgebildet — 1344×768 →
1536×1024, 768×1344 → 1024×1536 — und die Abweichung im Abschlusskommentar
genannt. Der Auftrag scheitert daran nicht.

**`quality`** gilt nur auf dem OpenAI-Pfad; lokal ist es bedeutungslos und wird
ignoriert. Umgekehrt gilt **`seed`** nur lokal — die OpenAI-API nimmt keinen
Seed entgegen. Wird beides gesetzt, wird das jeweils unwirksame Feld
stillschweigend übergangen; der Abschlusskommentar nennt immer nur die
tatsächlich verwendeten Einstellungen.

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

**Auftrag hängt** — über 5 Minuten ohne Ergebnis: ein Wiederholungsversuch mit
neuer `prompt_id`. Beim zweiten Mal Kommentar, Status `cancelled`, Mail. Fünf
Minuten sind großzügig gegenüber den gemessenen 72 Sekunden im kalten Fall und
lassen Raum für eine kurze Warteschlange auf dem Knoten.

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
- `test_workflow_template.py` — die Vorlage enthält alle vier Platzhalter; nach
  der Substitution bleibt keiner übrig und das Ergebnis ist gültiges JSON
- `test_comfy_client.py` — Antworten auf `/prompt` und `/history` (läuft /
  fertig / Fehler) gegen Fixtures parsen, `/view`-URL korrekt bauen; kein Netz
- `test_job_state.py` — Auftrag anlegen, einsammeln, Zeitüberschreitung,
  Wiederholung, Entfernen; Zustand übersteht einen Neustart
- `smoke_comfy.py` — manuelles Skript gegen den echten Knoten, Ende zu Ende.
  Läuft bei der Einrichtung, nicht in der Suite. Der Messlauf vom 02.08.2026
  (`qwen_bench.py`) ist die Vorlage dafür.

## Offene Punkte

1. **Lizenz der Turbo-LoRA prüfen.** `Wuli-Qwen-Image-2512-Turbo-LoRA-2steps`
   ist eine Drittanbieter-LoRA; Qwen-Image selbst ist Apache 2.0, die LoRA
   nicht automatisch mit. Vor dem produktiven Einsatz in Kundenmaterial klären.
   Fällt sie aus, bleibt Qwen ohne LoRA nutzbar — dann mit deutlich mehr Steps
   und entsprechend längerer Renderzeit.
2. **Abgebrochener Download aufräumen.** In
   `~/ComfyUI-Shared/models/.desktop2-downloads/` liegen 10 GB einer nie
   fertiggestellten `qwen_image_edit_2511_int8_convrot.safetensors.tmp`.
   Löschen oder den Download zu Ende führen — Letzteres nur, wenn Bildbearbeitung
   (img2img, Inpainting) wirklich gebraucht wird. Diese Spec braucht sie nicht.
3. **Video-Spec.** LTX und Hunyuan liegen auf dem Mac Studio, nicht auf dem
   MacBook. Ob die Modelle umziehen oder ein zweiter Knoten entsteht,
   entscheidet die Video-Spec.

## Quellen

- [Can I Use FLUX for Commercial Use? — Civitai](https://civitai.com/articles/6625/can-i-use-flux-for-commercial-use)
- [Model Licenses and Restrictions — DeepWiki / black-forest-labs/flux](https://deepwiki.com/black-forest-labs/flux/5.1-model-licenses-and-restrictions)
- [FLUX.2 Pro and Dev FAQ: Licensing and API Use — Flowith](https://flowith.io/blog/flux-2-pro-dev-faq-licensing-lora-fine-tuning-api-rate-limits-self-hosting/)
- [Qwen-Image ComfyUI Native, GGUF, and Nunchaku Workflow Guide — ComfyUI Wiki](https://comfyui-wiki.com/en/tutorial/advanced/image/qwen/qwen-image)
- [Qwen Image ComfyUI: Generate and Edit Images (2026) — Thunder Compute](https://www.thundercompute.com/blog/qwen-image-edit-comfyui)
