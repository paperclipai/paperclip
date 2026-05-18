---
name: content-pipeline
description: >
  Ecosistema completo de Paperclip en Railway (3 empresas: Discontrol Historys, DiscontrolsBags, DiscontrolDrops).
  Úsala cuando trabajes con cualquier agente Python, el frontend Studio, el Director,
  integraciones con Higgsfield/ElevenLabs/OpenRouter/Polymarket, o gestión de empresas en Paperclip.
  Cubre: arquitectura del pipeline de contenido, sistema de trading Polymarket, agentes de dropshipping,
  patrones de código, despliegue en Railway, endpoints internos y problemas conocidos.
---

# Content Pipeline — Paperclip (Discontrol Historys)

Canal: YouTube `@Discontrolhistorys` + TikTok `historias.en.sombra`
Nicho: crimen real, drama personal, historias impactantes en español.
Proyecto de generación automática de videos virales para TikTok/YouTube Shorts (9:16).
El Director orquesta agentes especializados que producen guión, imágenes, clips y video final.

---

## 1. Arquitectura del pipeline

```
Usuario (Studio) → Director → Deep Search
                            → Channel Analyzer
                            → Storytelling
                            → TTS (ElevenLabs)           ← en paralelo con Prompt Generator
                            → Prompt Generator
                            → Popcorn Auto ×2 lotes      ← 8+8 = 16 imágenes coherentes
                            → Imagen Video (DoP Lite)    ← 15 clips first-last-frame
                            → Video Assembler (FFmpeg)   ← MP4 final 9:16 con audio
```

**Agentes individuales** (desde Studio, sin Director):
- `imagen.py` → genera imágenes con Soul API (soul_style text field)
- `imagen_video.py` → genera clips con DoP Lite/Turbo/Standard First-Last Frame
- `popcorn.py` → genera set de imágenes coherentes con Popcorn Auto
- `tts.py` → narración con ElevenLabs
- `video_assembler.py` → ensambla MP4 con FFmpeg

---

## 2. Archivos clave

```
agents/
  director.py          # Orquestador principal — LEE SIEMPRE antes de modificar
  imagen.py            # Soul API (texto → imagen) — campo: soul_style (texto, no UUID)
  imagen_video.py      # DoP Lite/Turbo/Standard First-Last Frame — campo: dop_motion (texto)
  popcorn.py           # Popcorn Auto — 1 prompt → N imágenes coherentes
  video_assembler.py   # FFmpeg — ensambla clips + audio
  tts.py               # ElevenLabs TTS — extrae solo narración del guión
  api_client.py        # Helpers: post_issue_result, post_issue_comment, post_parent_update

server/src/
  app.ts               # Express API — incluye /api/internal/fix-agent-timeout

frontend/
  index.html           # Studio UI — SPA completa en un solo archivo HTML+JS+CSS
```

---

## 3. Variables de entorno requeridas

| Variable | Uso |
|---|---|
| `OPENROUTER_API_KEY` | LLM calls (Claude Haiku/Sonnet via OpenRouter) |
| `HIGGSFIELD_API_KEY` | Solo `<key>` para Popcorn/DoP; `<uuid>:<secret>` para Soul v1 |
| `ELEVENLABS_API_KEY` | TTS narración |
| `PAPERCLIP_API_KEY` | Auth Paperclip API |
| `PAPERCLIP_API_URL` | URL de la API (ej: `https://spirited-charm-production.up.railway.app`) |
| `PAPERCLIP_COMPANY_ID` | ID de la empresa en Paperclip |

---

## 4. APIs de Higgsfield

### Soul (texto → imagen)
- **Endpoint v1**: `POST https://platform.higgsfield.ai/v1/text2image/soul`
- **Auth**: headers `hf-api-key: <uuid>` + `hf-secret: <secret>`
- **Campo estilo**: `soul_style` (nombre texto, ej: "Cinematic") — NO usar UUID
- **Campo tamaño**: `width_and_height` (ej: "1152x2048" para 9:16)
- **Dentro de**: `{ "params": { ... } }`

### Popcorn Auto (prompt → N imágenes coherentes)
- **Endpoint**: `POST https://platform.higgsfield.ai/higgsfield-ai/popcorn/auto`
- **Auth**: `Authorization: Key <api_key>`
- **Payload**: `{ prompt, aspect_ratio, num_images (1-8), resolution, image_urls }`
- **Poll timeout**: 360s — la cola puede tardar >100s
- **Poll**: `GET /requests/{id}/status` → `status == "completed"` → `images[].url`
- **Retry**: 3 intentos automáticos si `status == "failed"` (error de servidor), con 30s/60s de espera
- **NSFW**: NO se reintenta — falla inmediato
- **Director lanza 2 lotes**: 8+8 imágenes → 16 total → 15 clips

### DoP First-Last Frame (2 imágenes → clip)
- **Endpoints**:
  - `higgsfield-ai/dop/lite/first-last-frame` — **2 cr/clip — DEFAULT**
  - `higgsfield-ai/dop/turbo/first-last-frame` — 6.5 cr/clip
  - `higgsfield-ai/dop/standard/first-last-frame` — 9 cr/clip
- **Auth**: `Authorization: Key <api_key>`
- **Payload**: `{ image_url, end_image_url, prompt, motions: [{id, name, strength}], enhance_prompt, duration }`
- **Parámetro `duration`**: soportado — default 5s (vs ~3s default API). Se calcula dinámicamente.
- **Poll**: `GET /requests/{id}/status` → `status == "completed"` → `video.url`
- **Patrón**: N imágenes → N-1 clips (pares consecutivos, lotes de 3 en paralelo)
- **Timeout agente Paperclip**: 1800s (30 min) — configurado vía `/api/internal/fix-agent-timeout`

### Duración de clips (imagen_video.py)
```python
# Si target_duration llega en el JSON de input:
clip_duration = min(8, max(3, ceil(target_duration / n_clips)))
# Si no llega target_duration:
clip_duration = 5  # default — 15 clips × 5s = 75s
```
Director extrae `target_duration` del storytelling con regex y lo pasa en `_iv_json`.

### Motions DoP — arco narrativo automático
```python
NARRATIVE_MOTIONS = [
    ["Dolly In"],                  # apertura (<20% del video)
    ["Arc Right", "Focus Change"], # desarrollo (20-45%)
    ["Crash Zoom In"],             # tensión (45-70%)
    ["Crane Up", "Dolly Out"],     # clímax/resolución (>70%)
]
```
El Director NO pasa `dop_motion` fijo — imagen_video elige según posición narrativa.
Desde Studio sí se puede pasar `dop_motion` override para uso manual.

### Soul Styles (106 disponibles, campo `soul_style` = nombre texto)
Categorías: Retratos/Makeup, Moda/Editorial, Y2K/Retro, Cámara/Efecto visual,
Escenarios/Localizaciones, Surreal/Fantasy/Arte, Lifestyle/Mood, General.
Ejemplos: "Spotlight", "90's Editorial", "Y2K", "Rainy Day", "Realistic", "Glitch", "Artwork", "General"

---

## 5. Patrones de código importantes

### Comunicación Director → Studio (async)
```python
# En api_client.py — notificar Studio con resultado de agente asíncrono
marker = f"AGENT_UPDATE_START:{agent_name}:\n{output[:9500]}"
# Se postea como comentario en el issue PADRE
```

### PIPELINE_ACTIVE — indicador de etapa activa en Studio
```python
post_issue_comment("PIPELINE_ACTIVE:popcorn")      # activa spinner de Popcorn
post_issue_comment("PIPELINE_ACTIVE:tts")           # activa spinner de TTS
post_issue_comment("PIPELINE_ACTIVE:imagen_video")  # activa spinner de Imagen Video
```

### PARENT_ISSUE_ID (agentes asíncronos)
```python
# Director inyecta en la descripción del sub-issue:
_desc = f"PARENT_ISSUE_ID:{issue_id}\n{task}"

# El agente lo extrae así:
_parent_match = re.search(r'PARENT_ISSUE_ID:([^\n\s>]+)', raw)
os.environ['PAPERCLIP_PARENT_ISSUE_ID'] = _parent_match.group(1)
```

### ASSEMBLER_PARAMS (Director → Imagen Video → Video Assembler)
```python
# Director embeds in imagen_video task:
_asm_params = {
    "image_urls":     _img_urls,
    "audio_path":     audio_path,
    "audio_url":      audio_url_tts,
    "tema":           objetivo[:100],
    "narration_text": narration_text[:3000],  # para subtítulos (si se activan)
}
_iv_task = f"ASSEMBLER_PARAMS:{json.dumps(_asm_params)}\n\n{_iv_input}"

# imagen_video.py extrae y lanza video_assembler como proceso detachado:
proc = subprocess.Popen([sys.executable, script], stdin=PIPE, start_new_session=True, env=env)
```

### Prompt Popcorn — anti-NSFW
El preamble es POSITIVO y corto. NO listar palabras prohibidas (activan filtros):
```python
_copyright_safe = (
    "Cinematic story visuals. Anonymous fictional characters in original settings. "
    "Dramatic atmosphere, artistic composition, photorealistic style.\n\n"
)
```
El guión se sanitiza antes de enviarlo: `asesinato→confrontation`, `droga→contraband`, `pistola→tension`, etc.

### Extracción de narración en TTS (tts.py)
El emoji `🎙️` son 2 codepoints: `🎙` (U+1F399) + `️` (U+FE0F). Los LLMs a veces omiten el segundo.
Usar `"\U0001f399" in stripped` (busca el codepoint base) para detección robusta.
```python
_NARRATION_MARKER = re.compile(
    r'(?:🎙[️\ufe0f]?\s*)?(?:\*{1,3})?\s*(?:NARRACIÓN|VOZ\s+EN\s+OFF|LOCUCIÓN|VOICE\s*OVER)\b',
    re.IGNORECASE
)
```
Requiere ≥20 palabras extraídas antes de considerar éxito (evita capturar solo la línea del marcador).

### Voz ElevenLabs (tts.py) — ajuste de expresividad
```python
"voice_settings": {
    "stability": 0.20,        # muy bajo = máxima expresividad dramática
    "similarity_boost": 0.80,
    "style": 0.80,            # alto = mucha emoción en pausas y énfasis
    "use_speaker_boost": True
}
```

### Input desde Studio (imagen_video.py)
```json
{
  "image_urls": ["..."],
  "dop_model": "lite",          // "lite" | "turbo" | "standard"
  "dop_motion": "Crash Zoom In", // override narrativo (opcional)
  "target_duration": 70          // segundos objetivo del video (opcional)
}
```

---

## 6. Studio frontend (frontend/index.html)

SPA en un único archivo HTML. Agentes registrados en `AGENTS = { key: config }`.

### Selectores visuales
- **🎨 Estilo Soul** (`#soulStyleSection`): visible solo para agente `imagen`. 106 estilos en 8 optgroups.
- **🎬 Motion DoP** (`#dopMotionSection`): visible solo para agente `imagen_video`. 121 motions. Default: "Auto (arco narrativo)".
- **⚡ Modelo DoP** (`#dopModelSection`): visible para `imagen_video`. Lite (default) / Turbo / Standard.

### Polling de resultados async
```javascript
// Cada 8s, busca marcadores AGENT_UPDATE_START en comentarios del issue padre
regex: /AGENT_UPDATE_START:(\w+):\n?([\s\S]*)/
// Fetch: GET /api/issues/{id}/comments?limit=100
```

### IDs de agentes Paperclip
```javascript
director:      'director-agent-id'
imagen:        '2492962a-b9f0-4611-90e2-c7ccca5aa281'
imagen_video:  '62e14c73-905b-45ce-b4d9-4cd532ec3dca'
tts:           '0d43b313-77b5-481b-83cc-a41485823f8e'
video:         '28f0a4aa-a230-4d82-aedf-4c327ab4a506'
```

---

## 7. Despliegue

```bash
# Siempre en: C:\Users\Alejandro\paperclip
git add <archivos>
git commit -m "descripción"
git push  # Railway redeploy automático en ~2-3 min
```

URL producción: `https://spirited-charm-production.up.railway.app/studio`

**Agentes que NO necesitan commit** (corren como subprocess en Railway):
- `popcorn.py`, `imagen_video.py`, `video_assembler.py`, `tts.py`
  → Se llaman desde `director.py` que sí corre en Railway.

### Fix de timeout de agente (endpoint interno)
Si imagen_video expira antes de terminar todos los clips:
```
GET https://spirited-charm-production.up.railway.app/api/internal/fix-agent-timeout
Authorization: Bearer <PAPERCLIP_API_KEY>
```
Respuesta: `{"ok":true,"timeoutSec":1800}` — setea 30 min en el adapter de Paperclip.
El endpoint actualiza TANTO `timeoutSec` COMO el campo legacy `timeout` en adapterConfig.

---

## 8. Problemas comunes y soluciones

| Problema | Causa | Solución |
|---|---|---|
| Studio no muestra clips/video | Marcador `AGENT_UPDATE_START` no llega | Verificar `post_parent_update` en api_client.py |
| Imagen Video expira con 3/5 lotes | timeout de 600s en adapterConfig | Llamar `/api/internal/fix-agent-timeout` |
| Popcorn `queued→failed` inmediato | Sobrecarga de servidor Higgsfield | Retry automático x3 en popcorn.py |
| Popcorn `nsfw` inmediato | Prompt con palabras de lista negra | Preamble positivo + sanitizar guión en director.py |
| TTS lee todo el guión | Emoji 🎙️ sin U+FE0F → fallback a texto completo | Fix en tts.py: buscar U+1F399 base |
| Video muy corto (45s en vez de 70s) | DoP genera 3s/clip por defecto | Pasar `duration:5` (default) o `target_duration` desde director |
| HTTP 409 en sub-issue | Dos procesos intentan cerrar el mismo issue | Usar `paperclip_timeout=0` (fire-and-forget) para agentes asíncronos |
| Soul API devuelve error | HIGGSFIELD_API_KEY no es `uuid:secret` | Verificar formato; imagen.py usa `parse_api_key()` para dividirlo |
| Director re-ejecuta al terminar | Paperclip re-despierta cuando sub-issues terminan | Guardia: salir si issue ya está `done` |

---

## 9. Costes de producción (referencia)

| Componente | Coste aprox. |
|---|---|
| Popcorn 16 imágenes (2 lotes) | ~$0.25 |
| DoP Lite 15 clips (2 cr/clip) | ~$1.87 |
| ElevenLabs TTS (~500 palabras) | ~$0.15 |
| OpenRouter LLM (4 agentes + síntesis) | ~$0.03 |
| **Total por video** | **~$2.30** |

Con 500 créditos Higgsfield (~$31): ~13-14 videos completos.

---

## 10. Features implementadas (historial)

- **Popcorn Auto**: reemplaza Soul en el Director — imágenes coherentes de una sola llamada
- **DoP Lite default**: 2 cr/clip vs 6.5 Turbo — modelo seleccionable desde Studio
- **Duración dinámica**: clips de 5s default; calcula `ceil(target/clips)` si storytelling especifica duración
- **Arco narrativo**: motions variados por posición del clip (apertura→desarrollo→tensión→resolución)
- **Inteligencia del Director**: LLM elige `soul_style` basándose en tendencias de Deep Search
- **Popcorn retry x3**: reintenta automáticamente en errores de servidor, falla rápido en NSFW
- **TTS narración robusta**: detecta sección 🎙️ con y sin variation selector U+FE0F
- **Voz más expresiva**: stability 0.20, style 0.80 en ElevenLabs
- **Anti-NSFW Popcorn**: preamble positivo + sanitización de palabras de crimen en el guión
- **PIPELINE_ACTIVE markers**: Studio actualiza UI en tiempo real según etapa activa
- **Timeout 30 min**: agente imagen_video configurado a 1800s vía endpoint interno
- **narration_text en pipeline**: fluye Director → TTS → imagen_video → assembler (para subtítulos futuros)
- **Studio selectores**: 106 Soul Styles + 121 DoP Motions + 3 modelos DoP en dropdowns

---

## 11. Canal y contexto del negocio

- **Canal YouTube**: `@Discontrolhistorys` — crimen real, historia, drama personal en español
- **Referencia de éxito**: "En 1983… Pablo Escobar" — 1.100 vistas, 90.7% retención en 16h (canal con 5 subs)
- **Prompts que funcionan para el nicho**:
  - "La noche que Pablo Escobar llamó al número equivocado"
  - "El piloto que aterrizó sin saber que llevaba cocaína"
  - "Descubrí que mi marido tenía otra familia cuando fui al banco"
- **Modelo de negocio objetivo**: agencia de contenido en España (€25-35/video), autónomo tarifa plana €80/mes primer año

---

## 12. Frontend Studio — estado actual (2025-05-06)

### 4 pantallas disponibles

| Ruta | Archivo | Estado |
|---|---|---|
| `/studio` | `frontend/index.html` | ✅ Funcional — bug JS crítico resuelto |
| `/agentes` | `frontend/agentes.html` | ✅ 10 agentes reales, sin datos falsos |
| `/estadisticas` | `frontend/estadisticas.html` | ✅ Datos reales de Supabase via proxy |
| `/biblioteca` | `frontend/biblioteca.html` | ✅ Galería real de vídeos + modal |

### Bug crítico resuelto

CSS `.gallery-card { ... }` estaba dentro del `<script>` de `index.html`.
Causaba **SyntaxError → TODO el JS era undefined** → ningún agente era seleccionable, el botón Ejecutar no funcionaba.
Fix: CSS movido al bloque `<style>`. Commit `1fd98c46`.

### Proxy Supabase seguro

La clave `SUPABASE_KEY` nunca se expone en HTML del cliente.
El servidor (`app.ts`) la usa internamente:
```
GET /api/content/videos?limit=N  → lista paginada de vídeos
GET /api/content/stats           → {total, withVideo, withImages, costPerVideo: 2.30}
```

⚠️ `SUPABASE_URL` en Railway ya incluye `/rest/v1`.
El proxy lo normaliza con: `url.replace(/\/rest\/v1\/?$/, "")` antes de añadir la ruta.

### Diseño visual

- Fuentes: Barlow + Barlow Condensed + DM Mono + Space Grotesk
- Colores: `--accent: #a855f7` (púrpura) + dark `#0d0d0f`
- Ambient blobs animados (CSS), sidebar unificado en todas las pantallas
- Horizontal pipeline stepper en el panel derecho cuando el Director está activo
