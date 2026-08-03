# 360-Panoramen und Video auf dem Renderknoten

**Stand:** 2026-08-03
**Knoten:** MacBook M5 Max, 128 GB, `192.168.2.40` (SSH-User `walterschonenbrocher`)

## Was jetzt geht

| Fähigkeit | Weg | Status |
|---|---|---|
| Bild (flach) | Bild-Dienst → ComfyUI, `modell: qwen` | live, ~14 s |
| **360-Panorama** | Bild-Dienst → ComfyUI, `modell: qwen360` | **live, ~5–6 min** |
| Video (kurze Clips) | LTX-2.3 über `ltx-2-mlx` (MLX-CLI) | in Arbeit |
| 360-Video | — | kein produktionsreifes freies Modell |
| Stereoskopie | — | zurückgestellt |

## 360-Panoramen

**Bestellung** wie beim normalen Bild, nur mit `modell: qwen360`. Format
2048×1024 (2:1) ist Standard und wird bei abweichender Angabe erzwungen.

### Was auf dem Knoten liegt

- LoRA `qwen-360-diffusion-int4-bf16-v1.safetensors` (ProGamerGov, MIT)
- Custom Nodes `ComfyUI_preview360panorama`, `ComfyUI_pytorch360convert`
- **Eigene Modellkopien** `qwen_image_2512_fp8_e4m3fn_360.safetensors` und
  `qwen_image_vae_360.safetensors`

### Drei Fallstricke, die Zeit gekostet haben

**1. LoRA-Variante muss zur Quantisierung des Basismodells passen.**
Die naheliegende Wahl `qwen-360-diffusion-2512-int8-bf16-v2` ist auf
Qwen-Image-**2512** trainiert — also auf genau unser Basismodell — erzeugt
auf einem `fp8_e4m3fn`-Transformer aber großflächige Patch-Artefakte. Die
Modellkarte beschreibt das und empfiehlt für fp8 die **int4**-Variante.
Erst `int4-bf16-v1` liefert saubere Bilder. Gegenprobe: derselbe Seed,
dieselben Sampler-Werte, nur die LoRA getauscht.

**2. Turbo-LoRA und 360-LoRA vertragen sich nicht.**
Mit der 2-Schritt-Turbo-LoRA (die den normalen Bildpfad auf 14 s bringt)
bleibt das Panorama verrauscht und unfertig. Der 360-Pfad läuft deshalb
**ohne Turbo mit 20 Schritten, cfg 3.5** und braucht gemessen ~330 s.
Folge: `JOB_TIMEOUT_SEC = 300` hätte jeden Lauf kurz vor dem Ziel
abgeräumt und neu eingereiht → modellabhängige Zeitgrenze
`MODEL_JOB_TIMEOUT_SEC = {"qwen360": 900}`.

**3. Circular Padding wirkt inplace und verseucht die normalen Bilder.**
Ohne Padding bleibt eine sichtbare Naht an der Bildkante. Gemessen als
Verhältnis „Differenz erste/letzte Spalte" zu „mittlere Differenz
benachbarter Spalten":

| Variante | Verhältnis |
|---|---|
| ohne Padding | 2,33 (deutlich sichtbare Naht) |
| mit Padding | 0,75–1,39 (je nach Motiv) |

Die Kennzahl hängt stark vom Bildinhalt ab: Ein Motiv mit viel glatter
Fläche senkt den Referenzwert und treibt das Verhältnis nach oben, obwohl
die Naht absolut kleiner ist. Verlässlicher ist der Blick auf den
umgerollten Nahtbereich. Realistischer Stand: In dunklen und texturierten
Bereichen ist die Naht verschwunden, auf **großen gleichmäßig hellen
Flächen** (Boden, Himmel) bleibt eine feine vertikale Linie erkennbar.
Für Skybox- und Hintergrundzwecke tragbar; wer sie ganz weghaben will,
bräuchte einen zweiten Durchlauf über `Create Seam Mask` + Inpainting.

Der Node `Apply Circular Padding Model` verändert mit `inplace=true` aber
das im Knoten **zwischengespeicherte** Modell. Nachgewiesen: nach einem
360-Lauf renderte ein gewöhnlicher Auftrag mit identischem Seed messbar
anders (1,8 % abweichende Pixel, Spitzenabweichung 169). Der eigentlich
vorgesehene Ausweg `inplace=false` scheitert auf dieser ComfyUI-Version
am `deepcopy` des ModelPatcher (`TypeError: 'NoneType' object is not
callable`).

**Lösung:** Der 360-Workflow lädt **eigene Dateikopien** von UNet und VAE.
ComfyUI cached pro Dateiname, damit ist es eine getrennte Instanz und das
Padding trifft nur sie. Kosten: 19 GB Plattenplatz. Nachgewiesen: normale
Bilder vor/nach einem 360-Lauf sind bitgleich (max. Abweichung 0.0).

> **Nicht anfassen:** Wenn jemand die Kopien „aufräumt" und den 360-Workflow
> auf die Originaldateien zeigen lässt, sind die Panoramen weiterhin schön —
> aber alle normalen Bilder ändern sich still. Der Test dafür liegt in
> `test_workflow_template.py::test_qwen360_uses_dedicated_model_copies`.

### Nebenwirkung: Modellwechsel kostet Ladezeit

Zwei 19-GB-Modelle passen nicht dauerhaft gleichzeitig in den Cache.
Wechselt der Knoten zwischen normalen und 360-Aufträgen, kommt jedes Mal
ein Nachladen dazu (gemessen: das Normalbild nach einem 360-Lauf brauchte
76 s statt 18 s). Kein Fehler, aber bei gemischten Stapeln einplanen.

## Video (LTX-2.3)

**Modellwahl — warum LTX und nicht Wan oder Hunyuan:**

- **HunyuanVideo 1.5** scheidet aus **Lizenzgründen** aus: die Tencent
  Hunyuan Community License definiert „Territory" ausdrücklich als weltweit
  **ohne EU, UK und Südkorea**. Für eine deutsche Firma nicht nutzbar.
- **Wan 2.2** hat die sauberste Lizenz (Apache 2.0) und die beste Qualität,
  ist auf Apple Silicon aber unbrauchbar langsam (fremde Messung: 82 min
  für 2 Sekunden auf einem M1 Max).
- **LTX-2.3** ist frei für Firmen unter 10 Mio. $ ARR und läuft über den
  MLX-Port nativ auf Metal.

**Wichtig:** In ComfyUI scheitert LTX auf MPS (offizielle Pipeline erzeugt
NaN; das Mac-Ticket wurde im April 2026 ungelöst geschlossen). Der gangbare
Weg ist der eigenständige MLX-Port `dgrauet/ltx-2-mlx` (MIT).

### Was auf dem Knoten eingerichtet ist

- `~/ltx-2-mlx` mit eigener venv (`uv sync --all-extras`) — **getrennt von
  der ComfyUI-venv**, damit der laufende Bilddienst nicht gefährdet wird
- ffmpeg 7.1 arm64 aus `imageio-ffmpeg`, verlinkt nach `~/.local/bin/ffmpeg`
  (auf dem Knoten gibt es kein Homebrew)
- Gewichte `dgrauet/ltx-2.3-mlx-q8` (ohne die redundanten `*-1.1`-Dubletten)
  plus Text-Encoder `mlx-community/gemma-3-12b-it-4bit`

### Gemessen am 03.08. (Erstlauf, `--two-stage`)

Clip: 704×448, 97 Frames, 24 fps = 4,04 s, **mit synchronem Ton** (AAC).
Qualität überzeugend: kohärente Kamerafahrt, stabile Personen und
Beleuchtung über alle Frames.

| Abschnitt | Zeit |
|---|---|
| Denoising Stufe 1 (30 Schritte, 6,08 s/Schritt) | 2:52 |
| Denoising Stufe 2 (3 Schritte) | 0:21 |
| **Rechnen gesamt** | **~3:13** |
| **Wanduhr gesamt** | **41:28** (2488 s) |

**Das ist der entscheidende Befund:** Das Erzeugen dauert gut drei Minuten,
die restlichen ~38 Minuten gehen fürs **Laden der Gewichte** drauf. Die CLI
lädt bei jedem Aufruf über 20 GB frisch von der Platte.

→ **Video darf nicht als Ein-Schuss-CLI je Auftrag laufen.** Es braucht einen
**residenten Prozess**, der die Gewichte einmal lädt und danach Aufträge
entgegennimmt — genau wie ComfyUI es für Bilder tut. Dann liegt ein Clip bei
rund drei bis vier Minuten statt bei vierzig.

Zur Einordnung: Die im Netz zitierten „152 s für 5 Sekunden auf einem M4 Max"
beziehen sich auf die **reine Denoising-Zeit** und decken sich mit unseren
3:13 — nicht auf die Wanduhr eines Kaltstarts.

### Offen
- Anbindung an Paperclip (eigenes Label oder `modell: ltx` im Bilddienst)
- Alternative: `dgrauet/ComfyUI-LTXVideo-mlx` brächte Video in denselben
  ComfyUI-Knoten und damit in die bestehende Dienst-Mechanik — zieht aber
  `ltx-core-mlx` in die **Produktions-venv** des Bilddienstes. Erst nach
  Abnahme des CLI-Wegs entscheiden.
