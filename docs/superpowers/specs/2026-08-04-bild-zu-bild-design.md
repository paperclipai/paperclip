# Bild→Bild im Bilddienst (Qwen-Image-Edit)

**Stand:** 2026-08-04
**Status:** entworfen, noch nicht gebaut
**Knoten:** MacBook M5 Max, `192.168.2.40`, ComfyUI auf Port 8189

## Warum

Der Bilddienst kann heute nur aus Text erzeugen (`qwen`, `qwen360`, `openai`).
Eine Variante eines vorhandenen Bildes, eine Retusche oder „nimm dieses
Produkt und stelle es in diese Szene" ist nicht bestellbar — obwohl das
passende Modell auf dem Renderknoten bereits liegt:

- `qwen_image_edit_2511_int8_convrot.safetensors` (19 GB)
- LoRA `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`

Es fehlt allein die Verdrahtung: eine Workflow-Vorlage, ein Modellname im
Brief und ein Weg, das Quellbild auf den Knoten zu bekommen.

> **Korrektur vom 04.08., nach dem ersten Rauchtest:** Der Satz oben war
> falsch — genauer: er verwechselte *liegt auf dem Knoten* mit *läuft auf dem
> Knoten*. `qwen_image_edit_2511_int8_convrot` ist **int8**-quantisiert, und
> die Int8-Matrixmultiplikation `aten::_int_mm` gibt es auf dem MPS-Backend
> nicht. Das Modell konnte auf Apple Silicon nie rechnen; der erste echte
> Auftrag scheiterte im `KSampler`.
>
> Für Qwen-Image-Edit **2511 gibt es kein reines `fp8_e4m3fn`** — nur `bf16`
> (40,9 GB), `fp8mixed` (20,5 GB) und eben `int8_convrot`.
>
> **Erster Ersatzversuch `fp8mixed` — ebenfalls gescheitert, gleicher Fehler.**
> „mixed" heißt hier nicht fp8 gemischt mit bf16, sondern fp8 **gemischt mit
> int8**. Belegt am safetensors-Kopf:
>
> | Variante | Datentypen im Kopf | läuft auf Metal |
> |---|---|---|
> | `2511_int8_convrot` | int8-Gewichte | nein |
> | `2511_fp8mixed` | 1679× F32, 1094× BF16, 839× F8_E4M3, **839× U8** | nein |
> | `2511_bf16` | 1933× BF16, 1× F32 | **ja** |
> | `2509_fp8_e4m3fn` | 1933× F8_E4M3 | ja, aber ältere Generation |
>
> Gewählt: **`bf16`** (40,9 GB). Die einzige 2511-Variante ohne Restunbekannte,
> und die Lightning-4steps-LoRA auf dem Knoten ist ebenfalls 2511/bf16 — das
> kanonische Paar. `2509 fp8` wäre halb so groß, brächte aber eine ältere
> Generation *und* eine zweite, erst zu beschaffende LoRA ins Spiel.
>
> **Die Lektion, allgemeiner:** Eine Modelldatei auf der Platte ist kein Beleg
> für Lauffähigkeit, und der Dateiname ist kein Beleg für das Format. Der
> safetensors-Kopf ist es — und er kostet nichts:
>
> ```bash
> # erste 8 Byte = Kopflaenge, danach der JSON-Kopf mit allen dtypes.
> # Per Range-Request, ohne die 40-GB-Datei zu laden.
> curl -sL -r 0-7 "$URL" | xxd            # Laenge n (u64 little endian)
> curl -sL -r 8-$((8+n-1)) "$URL" | jq '[.[] | .dtype] | group_by(.) | map({(.[0]): length}) | add'
> ```
>
> Taucht dort `U8` oder `I8` auf, scheitert der Lauf auf Apple Silicon an
> `aten::_int_mm`. Das ist die zweite und dritte Quantisierungsfalle dieses
> Knotens; die erste (LoRA-Variante gegen Basismodell) steht in
> [`2026-08-03-360-panorama-und-video.md`](2026-08-03-360-panorama-und-video.md).

## Umfang

**Drin:** ein bis drei Quellbilder je Auftrag, als Anhänge am Issue.
**Draußen:** Video (eigene Baustelle), Masken/Inpainting mit gezeichneter
Auswahl, Warteschlangen-Sortierung nach Modell.

## Bestellformat

Ein `bild`-Issue wie bisher, mit **einem bis drei Bildanhängen** und:

```
prompt: stelle das Produkt aus Bild 1 auf den Tisch in Bild 2
modell: qwenedit
seed: 42            # optional
```

**Reihenfolge = Anhang-Reihenfolge.** Der **zuerst** angehängte Bildanhang ist
„Bild 1". Im Prompt werden sie als *Bild 1*, *Bild 2*, *Bild 3* angesprochen;
bei einem einzigen Anhang braucht es keinen Verweis („entferne die Person im
Hintergrund").

> **Achtung, geprüft:** `GET /api/issues/{id}/attachments` liefert
> `orderBy(desc(createdAt))` — also **neuestes zuerst**. Der Dienst muss die
> Liste deshalb selbst **aufsteigend nach `createdAt`** sortieren, bei
> Gleichstand nach `id` als stabilem Zweitschlüssel. Ohne diese Umkehrung
> wäre „Bild 1" der **zuletzt** angehängte — genau falsch herum, und bei
> einem Auftrag mit einem Bild nicht einmal auffällig.

**`format:` gibt es bei `qwenedit` nicht.** Die Ausgabegröße folgt dem ersten
Quellbild, normiert auf ~1 Megapixel mit Kantenlängen als Vielfache von 16.
Ein trotzdem angegebenes `format:` wird ignoriert **und im Abschlusskommentar
vermerkt** — nicht stillschweigend verworfen.

### Fehlerfälle

Alle enden mit `cancelled` und einem Kommentar, der den Grund nennt:

| Fall | Verhalten |
|---|---|
| kein Bildanhang | Abbruch: „`modell: qwenedit` braucht mindestens einen Bildanhang" |
| mehr als drei Bildanhänge | Abbruch. **Nicht** stillschweigend auf drei kürzen — „Bild 2" meint sonst etwas anderes als der Besteller denkt |
| Nicht-Bild-Anhänge (PDF, xlsx) | ignoriert, zählen nicht mit |
| Anhang über 20 MB | Abbruch mit Größenangabe |
| fehlender `prompt` | wie bisher: Abbruch mit Formathinweis |

Bild-Anhang und Größe werden **an der Liste** entschieden, ohne die Datei zu
laden: Die Antwort enthält `contentType` (Filter `image/`), `byteSize`
(Größengrenze) und `originalFilename` (für den Upload-Namen). Ein zu großer
Anhang wird also erkannt, bevor er über die Leitung geht.

## Transportweg für das Quellbild

**Gewählt: HTTP-Upload an ComfyUI.** Der Dienst lädt den Anhang über die
Paperclip-API, schiebt ihn per `POST /upload/image` (multipart) auf den Knoten
und setzt den **vom Knoten zurückgemeldeten** Dateinamen in die
`LoadImage`-Node. Ein einziger Transportweg, derselbe HTTP-Kanal, den der
Dienst ohnehin nutzt; nichts Neues auf dem Knoten. Endpunkt am 04.08. als
vorhanden verifiziert (400 ohne Datei).

Verworfen:

- **SSH/rsync in `ComfyUI-Shared/input`** — bräuchte einen SSH-Key für den
  Dienst, Pfadwissen über einen zweiten Rechner und einen zweiten Fehlerraum
  neben HTTP. Kein Vorteil.
- **Base64 im Workflow** — bräuchte eine Custom Node (`ETN_LoadImageBase64`
  o. ä.), die nicht installiert ist. Zusätzliche Abhängigkeit in einer
  Produktions-Installation für nichts.

## Aufbau

Bild→Bild kommt als **dritter Renderpfad** neben `render_local` und
`render_openai` dazu. Das Bestehende wird nicht umgebaut.

| Modul | Änderung |
|---|---|
| `paperclip_api.py` | neu `list_attachments(issue_id)`, `fetch_attachment(attachment_id)` — `GET /api/issues/{id}/attachments` bzw. `GET /api/attachments/{id}/content`, gleiche Fehlerbehandlung wie der Rest (401/403 → `AuthError`) |
| `comfy_client.py` | neu `upload_image(filename, data)` — `POST /upload/image`, gibt den vom Knoten vergebenen Namen zurück; Parsen der Antwort netzfrei und getrennt testbar |
| `workflow_template.py` | neu `set_images(workflow, names)` — setzt `__IMAGE1..3__` und entfernt die ungenutzten `LoadImage`-Nodes **samt ihrer Referenzen** |
| `workflows/qwen-edit.api.json` | neue Vorlage (siehe unten) |
| `config.py` | `qwenedit` in `ALLOWED_MODELS`, `LOCAL_WORKFLOWS["qwenedit"] = "qwen-edit"`, `MAX_SOURCE_IMAGES = 3`, `MAX_SOURCE_BYTES = 20 * 1024 * 1024`, `MODEL_JOB_TIMEOUT_SEC["qwenedit"] = 600` |
| `brief_parser.py` | kennt `qwenedit`; meldet über ein Feld `format_ignored` zurück, dass ein angegebenes `format:` verworfen wurde |
| `job_state.py` | `add(...)` nimmt zusätzlich `sources` (Liste der hochgeladenen Namen) |
| `bild_service.py` | neu `render_edit()`; der Wiederholversuch in `collect_one` nutzt `job["sources"]` |

### Vorlage `qwen-edit.api.json`

```
3× LoadImage (__IMAGE1__, __IMAGE2__, __IMAGE3__)
      ↓
   ImageScaleToTotalPixels (megapixels 1.0, resolution_steps 16)
      ↓                              ↓
TextEncodeQwenImageEditPlus      VAEEncode (nur Bild 1)
 (clip, vae, image1..3, __PROMPT__)   ↓
      ↓                            LATENT
   KSampler (__SEED__) ────────────────┘
      ↓
   VAEDecode → SaveImage
```

`image1`, `image2` und `image3` sind an `TextEncodeQwenImageEditPlus`
**optional** (am 04.08. aus `/object_info` verifiziert). Deshalb genügt eine
einzige Vorlage für ein, zwei oder drei Bilder: Was nicht gebraucht wird,
schneidet `set_images` vor dem Absenden heraus.

`__WIDTH__`/`__HEIGHT__` kommen in dieser Vorlage nicht vor — das bestehende
`fill()` ersetzt sie dann folgenlos, es braucht keine Sonderbehandlung.

### Ablauf beim Absenden

```
Issue (todo|backlog, Label bild)
  → parse_brief            modell = qwenedit
  → list_attachments       nur contentType image/*, aufsteigend nach createdAt
  → prüfen                 1–3 Stück, je ≤ 20 MB   → sonst Abbruch + Kommentar
  → fetch_attachment       je Bild
  → comfy.upload_image     je Bild → Name vom Knoten
  → wt.fill + set_images   Prompt, Seed, Bildnamen; ungenutzte Slots raus
  → comfy.submit           → prompt_id
  → job_state.add(sources=[...])
```

Das Einsammeln (`collect_one`) bleibt unverändert: dieselbe Idempotenz über
`uploaded`, dasselbe Ergebnis-PNG als Attachment, derselbe Abschlusskommentar
(um Modellnamen und ggf. den `format:`-Hinweis ergänzt).

### Der Reentrance-Fallstrick

Der Dienst hängt **sein eigenes Ergebnis** als Attachment an dasselbe Issue.
Der automatische zweite Versuch nach einem Timeout liest den Brief neu ein —
läse er auch die Anhänge neu, würde er ab dem zweiten Versuch sein eigenes
Ergebnis als Quelle nehmen und still etwas anderes rendern, als bestellt war.

**Lösung:** Die hochgeladenen Namen werden beim Absenden in `job_state`
festgehalten; der Wiederholversuch nimmt sie von dort und lädt nichts neu.
Die Bilder liegen zu dem Zeitpunkt bereits auf dem Knoten.

Dafür gibt es einen eigenen Test — er ist der wichtigste des Bauvorhabens.

### Bewusste Nicht-Entscheidungen

- **Keine eigenen Modellkopien.** Das 360-Problem (der Node
  `Apply Circular Padding Model` wirkt `inplace` und verändert das im Knoten
  zwischengespeicherte Modell) gibt es hier nicht — die Edit-Vorlage patcht
  nichts. Es bleibt bei einer Modelldatei.
- **Teil-Upload wird nicht gerettet.** Scheitert ein Upload mitten in der
  Serie, wird der Auftrag gar nicht erst registriert und im nächsten Zyklus
  komplett neu versucht. Ein paar verwaiste Dateien in
  `ComfyUI-Shared/input` sind der Preis — billiger als eine halb
  hochgeladene Auftragsliste.

## Tests

Netzfrei, wie im Dienst üblich (Antwort-Parsen getrennt von HTTP):

- `test_brief_parser.py` — `qwenedit` wird angenommen; `format:` wird ignoriert
  und als ignoriert gemeldet; ein Tippfehler im Modellnamen fällt weiterhin
  auf `qwen` zurück
- `test_comfy_client.py` — Multipart-Aufbau von `upload_image`, Auswerten der
  Antwort, `ComfyError` bei HTTP-Fehler
- `test_paperclip_api.py` — `list_attachments` / `fetch_attachment`,
  inkl. 401 → `AuthError`. **Pflichttest:** eine absteigend sortierte
  API-Antwort kommt aufsteigend nach `createdAt` heraus — sonst ist „Bild 1"
  das zuletzt angehängte Bild
- `test_workflow_template.py` — `set_images` bei 1/2/3 Bildern: die ungenutzten
  `LoadImage`-Nodes und ihre Referenzen sind weg, das Ergebnis bleibt gültiges
  JSON. Dazu ein Wächter analog zu
  `test_qwen360_uses_dedicated_model_copies`: die Edit-Vorlage zeigt auf das
  Edit-Modell, nicht auf das normale
- `test_bild_service.py` — kein Anhang; vier Anhänge; zu großer Anhang;
  Nicht-Bild-Anhang; **und der Wiederholversuch nimmt `job["sources"]` und
  lädt nichts neu**

## Rauchtest am Knoten

Vor dem Scharfstellen, an einem Wegwerf-Issue:

1. **Ein Bild**, einfache Anweisung („entferne die Person") → Ergebnis
   ansehen, auf Artefakte prüfen, Dauer messen.
2. **Zwei Bilder kombinieren** → prüfen, ob „Bild 1"/„Bild 2" im Prompt
   tatsächlich die Anhang-Reihenfolge trifft.
3. **Gegenprobe:** direkt danach ein normaler `qwen`-Auftrag mit festem Seed —
   bitgleich zum selben Auftrag vor dem Edit-Lauf? Damit ist belegt, dass der
   Edit-Pfad den normalen Bildpfad nicht verändert.

**Offene technische Frage, die der Rauchtest beantworten muss:** ob die
`Lightning-4steps`-LoRA (bf16) sauber auf dem `int8_convrot`-Basismodell
sitzt. Beim 360-Pfad hat genau diese Paarung — LoRA-Quantisierung gegen
Basismodell-Quantisierung — großflächige Patch-Artefakte erzeugt. Fallback:
ohne LoRA mit 20 Schritten und cfg 3.5, dann langsamer.

## Ausrollen

- Die Skripte liegen unter `~/.paperclip/scripts/bild-service/`; Live-Pfad und
  Arbeitspfad sind identisch, es gibt keinen Deploy-Schritt. Der launchd-Dienst
  zieht die Änderung im nächsten Zyklus (≤ 60 s).
- **`_common.md` des Instruktions-Generators** bekommt den Bild→Bild-Absatz im
  Block „Bild/Grafik bestellen", inklusive des Hinweises, dass die Anhänge am
  *eigenen* Subtask hängen müssen. Danach `build-agents-md.py`
  `--backup` → `--dry-run` → `--apply` → `--verify`.
- **`ANLEITUNG-bild-video-auftraege.md`**: Bild→Bild wandert von „nicht
  bestellbar" auf einen eigenen Abschnitt, die Übersichtstabelle wird
  angepasst.
- Tageszähler (60 lokale Bilder) und die drei gleichzeitigen Renders gelten
  mit, ohne Sonderregel.

## Risiko

Der Knoten hält 19-GB-Modelle nicht mehrfach im Cache. Mit `qwenedit` sind es
**drei** große Modelle statt zwei — gemischte Stapel bedeuten häufigeres
Nachladen (beim 360-Wechsel gemessen: 76 s statt 18 s für das Folgebild). Das
bremst, bricht aber nichts. Wenn es stört, wäre die Antwort eine Sortierung
der Warteschlange nach Modell — bewusst nicht Teil dieses Bauvorhabens.

## Referenzen

- Bilddienst-Design: [`2026-08-02-comfyui-bild-renderer-design.md`](2026-08-02-comfyui-bild-renderer-design.md)
- 360°/Video und die LoRA-Quantisierungs-Lektion: [`2026-08-03-360-panorama-und-video.md`](2026-08-03-360-panorama-und-video.md)
- Bestell-Anleitung: [`../ANLEITUNG-bild-video-auftraege.md`](../ANLEITUNG-bild-video-auftraege.md)
