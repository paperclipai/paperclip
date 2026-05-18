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
GET  /               → frontend/landing.html      (Landing page pública — hero, precios, auth)
GET  /studio          → frontend/index.html       (Studio UI principal)
GET  /agentes         → frontend/agentes.html      (10 agentes reales)
GET  /estadisticas    → frontend/estadisticas.html (métricas Supabase)
GET  /biblioteca      → frontend/biblioteca.html   (galería de vídeos)

GET  /api/creator/config                   → {supabaseUrl, supabaseAnonKey} para Supabase Auth JS
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
| `SUPABASE_KEY` | Clave secreta Supabase (formato `sb_secret_...`) — solo servidor |
| `SUPABASE_ANON_KEY` | Clave pública Supabase (anon key) — expuesta en landing para Supabase Auth JS |
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

---

## DiscontrolsBags — Pipeline TradingView (rama: feat/bags-chido)

> Trabajo realizado por chido1203 + Claude. PR #2 mergeado a master.

### Qué se hizo

Se eliminó el pipeline de Polymarket y se reemplazó por un sistema de 5 agentes que genera **estrategias de trading algorítmico en Pine Script v5** para TradingView, orientadas a acciones (stocks). El pipeline completo se activa creando un issue en DiscontrolsBags con body `{"ticker": "AAPL", "style": "momentum"}`.

### Archivos del pipeline

```
agents/trading/
  ceo.py               ← Orchestrator: crea 5 sub-issues en secuencia
  stock_analyzer.py    ← Yahoo Finance OHLCV + SMA 20/50/200, ATR 14, volatilidad
  strategy_designer.py ← LLM (claude-sonnet-4-6) genera Pine Script v5 completo
  strategy_critic.py   ← LLM (claude-haiku-4-5) revisa lógica, bias, overfitting
  strategy_optimizer.py← LLM (claude-sonnet-4-6) refina el script con las correcciones
  reporter.py          ← Formatea output final con guía de uso para TradingView
  setup.py             ← Crea/actualiza agentes en Paperclip (ejecutar una sola vez)
```

### IDs de agentes en DiscontrolsBags

```python
CEO_AGENT_ID             = "41df12d7-71c4-494e-a503-d02ef88fb1d8"  # CEO Strategy Factory
STOCK_ANALYZER_ID        = "6f75364c-0ab2-48ac-9144-f40578435d67"  # ex Market Scanner
STRATEGY_DESIGNER_ID     = "ff3e3f5f-118f-451d-b042-91ec19d0cf11"  # ex Probability Estimator
STRATEGY_CRITIC_ID       = "149be654-dccb-4da3-a6c6-091c5b5fe1e6"  # ex Risk Manager
STRATEGY_OPTIMIZER_ID    = "61ced466-af5b-43be-a049-e94cf895274a"  # ex Executor
REPORTER_ID              = "74bc12a4-6928-4450-b472-2962c3516627"  # Reporter
TRADING_COMPANY          = "866b74e7-79a7-4166-9f9f-025faa751aa1"
```

Los UUIDs son los mismos agentes Polymarket reutilizados — solo cambia el script que ejecutan (adapterConfig actualizado por Alejandro en la UI).

### Estilos de estrategia soportados

`momentum` · `breakout` · `mean_reversion` · `reversal` · `trend_following` · `scalping`

### Bugs resueltos en esta sesión

| Bug | Causa | Fix |
|---|---|---|
| CEO HTTP 500 al crear sub-issues | `run_id` ficticio en JWT violaba FK constraint de `activity_log` | Usar `os.environ["PAPERCLIP_RUN_ID"]` |
| Sub-issues nunca se despertaban | `status: "backlog"` no lanza agentes | Cambiar a `status: "todo"` |
| Strategy Optimizer exit code 1 | Description del sub-issue truncada a 4000 chars — el bloque JSON del Critic quedaba cortado | Aumentar límite a 8000 en `ceo.py` + parsing multicapa en `strategy_optimizer.py` |
| Popcorn Auto creado en Bags | `seed-agents` buscaba agente con `.includes("director")` — matcheaba "Director ejecutivo" de Bags | Cambiar a `.toLowerCase() === "director"` en `app.ts` línea 519 |

### Patrón JWT para agentes Python

```python
# CRÍTICO: usar PAPERCLIP_RUN_ID del env var (nunca inventar un run_id)
# activity_log.run_id tiene FK → heartbeat_runs.id
payload = {
    "sub":          agent_id,
    "company_id":   company_id,
    "adapter_type": "process",
    "run_id":       os.environ["PAPERCLIP_RUN_ID"],  # real, no ficticio
    "iat":          now,
    "exp":          now + 172800,
    "iss":          "paperclip",
    "aud":          "paperclip-api",
}
```

### Notas de operación

- El CEO usa PATCH 500 que aplica el cambio aunque devuelva error (bug de activity_log con run_id externo). En producción el run_id es real y no hay 500.
- Para crear un issue de prueba sin permisos de UI: usar la API directamente con JWT del CEO.
- `POST /api/agents/{agentId}/wakeup` despierta un agente manualmente (requiere JWT del propio agente).
- El endpoint `seed-agents` es para Studio solamente — para Bags usar `seed-trading-agents`.
