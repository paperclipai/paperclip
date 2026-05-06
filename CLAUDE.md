# Paperclip — DiscontrolCreator

Servidor único en Railway que aloja el ecosistema Diskontrol completo.
URL pública: `https://spirited-charm-production.up.railway.app`

## Stack

- **Backend**: Node.js + Express + TypeScript (`server/src/app.ts`)
- **DB relacional**: PostgreSQL vía Paperclip (ORM interno)
- **DB contenido**: Supabase (`videos`, `trends`, `channels`)
- **Agentes Python**: `/agents/*.py` — se lanzan como subprocesos
- **Frontend**: `/frontend/*.html` — archivos HTML estáticos servidos por Express

## Rutas del servidor

```
GET  /studio          → frontend/index.html       (Studio UI principal)
GET  /agentes         → frontend/agentes.html      (10 agentes reales)
GET  /estadisticas    → frontend/estadisticas.html (métricas Supabase)
GET  /biblioteca      → frontend/biblioteca.html   (galería de vídeos)

GET  /api/content/videos?limit=N&offset=N  → proxy Supabase (clave secreta segura)
GET  /api/content/stats                    → conteo real de vídeos/imágenes

POST /preview         → guarda HTML en memoria, devuelve {id, url}
GET  /preview/:id     → sirve el HTML guardado (24h TTL)
GET  /sounds/:file    → success.m4a / error.m4a
GET  /terms, /privacy → páginas legales TikTok
```

## Variables de entorno (Railway)

| Variable | Uso |
|---|---|
| `SUPABASE_URL` | URL base Supabase — incluye `/rest/v1` (ej: `https://xxx.supabase.co/rest/v1`) |
| `SUPABASE_KEY` | Clave secreta Supabase (formato `sb_secret_...`) |
| `OPENROUTER_API_KEY` | LLM (Claude Haiku/Sonnet via OpenRouter) |
| `HIGGSFIELD_API_KEY` | Popcorn/DoP: `Key <key>` · Soul: `<uuid>:<secret>` |
| `ELEVENLABS_API_KEY` | TTS narración |
| `PAPERCLIP_API_KEY` | Auth Paperclip API |
| `PAPERCLIP_API_URL` | URL API interna (puede ser localhost en dev) |
| `PAPERCLIP_COMPANY_ID` | ID empresa Discontrol Historys |
| `YOUTUBE_API_KEY` | Data API v3 (3 keys rotativas) |
| `GOOGLE_MAPS_API_KEY` | Lead Scout (Growth) |

> ⚠️ SUPABASE_URL ya lleva `/rest/v1` — el proxy en app.ts lo normaliza con `.replace(/\/rest\/v1\/?$/, "")` antes de añadir la ruta.

## Despliegue

```bash
cd C:\Users\Alejandro\paperclip
git add <archivos>
git commit -m "descripción"
git push   # Railway autodeploy en ~2-3 min
```

## Empresas en Paperclip

| Empresa | Slug | CompanyID | Estado |
|---|---|---|---|
| Discontrol Historys (Studio) | AUTA | 4d39bc9c-a76c-4558-a3b0-2a3267124dc0 | ✅ Producción |
| DiscontrolsBags (Trading) | DIS | 866b74e7-79a7-4166-9f9f-025faa751aa1 | 🔧 DRY_RUN |
| DiscontrolDrops (Dropshipping) | DISA | 0b4751e7-24e7-4e8b-98e0-5b5ed73b6d7c | ✅ Funcional |
| DiscontrolGrowth (Ventas) | DISAA | 14a23847-5215-44fc-8b2d-c45e25d3f291 | 🔧 Parcial |

## Archivos clave

```
agents/
  director.py          ← Orquestador principal — leer antes de modificar
  db_client.py         ← Cliente Supabase REST (sin drivers externos)
  popcorn.py           ← Higgsfield Popcorn Auto
  imagen_video.py      ← DoP First-Last Frame
  video_assembler.py   ← FFmpeg ensamblado MP4
  tts.py               ← ElevenLabs narración
  api_client.py        ← post_issue_result, post_parent_update

server/src/
  app.ts               ← Express API + rutas frontend + proxy Supabase

frontend/
  index.html           ← Studio SPA (2800+ líneas, JS vanilla)
  agentes.html         ← Página agentes (estática, info real)
  estadisticas.html    ← Métricas (carga datos de /api/content/stats)
  biblioteca.html      ← Galería (carga datos de /api/content/videos)
```

## Bug crítico resuelto (2025-05-06)

CSS de `.gallery-card` estaba dentro del bloque `<script>` en `index.html`.
Causaba SyntaxError que impedía ejecutar TODO el JavaScript del Studio.
Fix: CSS movido al bloque `<style>`.

## Supabase — tabla `videos`

Columnas: `id, created_at, tema, guion, audio_url, video_url, image_urls[], hashtags[], duration_sec, status, platform, issue_id, director_run`

El proxy en `/api/content/videos` expone estos datos sin revelar `SUPABASE_KEY`.
