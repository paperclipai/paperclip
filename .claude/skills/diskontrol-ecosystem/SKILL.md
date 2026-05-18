---
name: diskontrol-ecosystem
description: >
  Ecosistema completo de Diskontrol — 4 empresas en Paperclip sobre Railway.
  Úsala cuando trabajes con DiscontrolsBags (trading), DiscontrolDrops (dropshipping),
  DiscontrolGrowth (captación de clientes), la infraestructura compartida,
  o el frontend del Studio (Studio/Agentes/Métricas/Biblioteca).
  Cubre: arquitectura, IDs de agentes, APIs, patrones de código, estado actual y pendientes.
---

# Diskontrol Ecosystem — Guía completa

## Infraestructura

```
Railway (servidor único — spirited-charm-production.up.railway.app)
├── Paperclip server (Node.js + PostgreSQL) — server/src/app.ts
├── Python agents (todos los pipelines) — agents/
├── Frontend DiscontrolCreator (4 pantallas HTML) — frontend/
└── Express endpoints internos (/api/internal/*) y proxy (/api/content/*)

Supabase (content pipeline DB)
  → videos, trends, channels tables
  → URL: https://nuaajypknpjbsyhssclm.supabase.co
  → SUPABASE_URL env var = "https://xxx.supabase.co/rest/v1" (ya lleva /rest/v1)
  → SUPABASE_KEY = clave secreta (sb_secret_...) — NUNCA en HTML del cliente
  → Proxy seguro: GET /api/content/videos y /api/content/stats

GitHub: alejandrojesusperezblanco4-commits/paperclip
  → push a master → Railway autodeploy (~2-3 min)
```

---

## Las 4 empresas en Paperclip

| Empresa | Slug URL | CompanyID | Estado |
|---|---|---|---|
| Discontrol Historys (Studio) | AUTA | 4d39bc9c-a76c-4558-a3b0-2a3267124dc0 | ✅ Producción |
| DiscontrolsBags (Trading) | DIS | 866b74e7-79a7-4166-9f9f-025faa751aa1 | 🔧 DRY_RUN |
| DiscontrolDrops (Dropshipping) | DISA | 0b4751e7-24e7-4e8b-98e0-5b5ed73b6d7c | ✅ Funcional |
| DiscontrolGrowth (Ventas) | DISAA | 14a23847-5215-44fc-8b2d-c45e25d3f291 | 🔧 Parcial |

---

## Frontend DiscontrolCreator — 4 pantallas

Todas servidas sin auth, HTML estático en `/frontend/`:

| Ruta | Archivo | Descripción |
|---|---|---|
| `/studio` | `index.html` | Studio SPA — 10 agentes, pipeline, galería Supabase |
| `/agentes` | `agentes.html` | 10 agentes reales con info y coste de producción |
| `/estadisticas` | `estadisticas.html` | Métricas reales desde Supabase (JS fetch) |
| `/biblioteca` | `biblioteca.html` | Galería de vídeos reales desde Supabase (JS fetch) |

### Proxy Supabase en el servidor

```typescript
// app.ts — rutas proxy (clave secreta nunca sale al cliente)
GET /api/content/videos?limit=N&offset=N  → lista vídeos ordenados desc
GET /api/content/stats                     → {total, withVideo, withImages, costPerVideo}

// IMPORTANTE: SUPABASE_URL env var ya incluye /rest/v1
// El proxy lo normaliza: url.replace(/\/rest\/v1\/?$/, "") antes de construir la ruta
```

### Bug crítico resuelto (2025-05-06)

CSS `.gallery-card { ... }` estaba dentro del `<script>` de `index.html`.
Causaba SyntaxError → TODO el JS era undefined → Studio completamente roto.
Fix: CSS movido al `<style>`. Commit: `1fd98c46`.

---

## DiscontrolDrops — Pipeline completo

### Agentes y sus IDs

```python
CEO_AGENT_ID             = "60dd4b7a-4ec3-4555-8e52-807ffcf15a7b"
PRODUCT_HUNTER_AGENT_ID  = "01a671f6-a303-4f74-90e2-914c63a2e34d"
AD_SPY_AGENT_ID          = "9d3649ad-b902-495a-8330-8048d94ac20d"
LEAD_QUALIFIER_AGENT_ID  = "fbf55d11-03cb-4d88-9132-7a04a9091d8c"
WEB_DESIGNER_AGENT_ID    = "e39f154b-0415-42f2-bd60-b79f66ecaca7"
MARKETING_CREATOR_AGENT_ID = "f6fb0f5a-ea32-4a29-aac1-95e7c3db6335"
DROPS_COMPANY            = "0b4751e7-24e7-4e8b-98e0-5b5ed73b6d7c"
DROPS_PROJECT_ONBOARDING = "7bd04480-4dec-4a12-973f-5a6dd0784bee"
```

### Flujo CEO

```
Issue al CEO: "nicho del producto"
    ↓
1. Product Hunter → Amazon BS + Google Trends + LLM → 10 productos
2. Ad Spy → Google Trends + YouTube + Google Shopping → evidence_score
3. Lead Qualifier → score 0-100 LAUNCH/TEST/SKIP (max_tokens=4000, timeout=90s)
4. Web Designer → estructura copy + HTML preview en Railway + preview URL
5. Marketing Creator → 3 ads + 2 TikTok scripts + emails
```

### Problemas críticos resueltos

1. **HTTP 500 en create_sub_issue** → usar `PAPERCLIP_RUN_ID` de env vars (no inventar)
2. **Sub-issues en backlog sin despertar** → crear con `status: "todo"` no "backlog"
3. **Lead Qualifier "No se encontraron productos"** → combined_json slim + description limit 8000
4. **JSONDecodeError Lead Qualifier** → max_tokens=4000 (no 2000)
5. **Web Designer sin datos** → manejo JSON crudo + extracción por regex del markdown
6. **Preview URL con localhost** → hardcode Railway URL en web_designer.py

---

## DiscontrolsBags — Trading Polymarket

### Agentes y sus IDs

```python
CEO_AGENT_ID             = "41df12d7-71c4-494e-a503-d02ef88fb1d8"
MARKET_SCANNER_AGENT_ID  = "6f75364c-0ab2-48ac-9144-f40578435d67"
PROBABILITY_ESTIMATOR_ID = "ff3e3f5f-118f-451d-b042-91ec19d0cf11"
RISK_MANAGER_AGENT_ID    = "149be654-dccb-4da3-a6c6-091c5b5fe1e6"
EXECUTOR_AGENT_ID        = "61ced466-af5b-43be-a049-e94cf895274a"
REPORTER_AGENT_ID        = "74bc12a4-6928-4450-b472-2962c3516627"
TRADING_COMPANY          = "866b74e7-79a7-4166-9f9f-025faa751aa1"
```

### Estado actual

- ✅ Agentes creados en Paperclip
- ✅ Market Scanner funcional (filtra solo crypto, min $5k volumen)
- ⚠️ CEO tiene bug run_id (mismo fix que Drops — pendiente aplicar)
- ⚠️ Telegram no configurado
- ⚠️ TikTok Research API — 401 (app en revisión)

---

## DiscontrolGrowth — Captación de clientes

### Agentes y sus IDs

```python
CEO_GROWTH_AGENT_ID          = "8a58fe92-6799-42e0-81e0-d3f234dbf5cc"
LEAD_SCOUT_AGENT_ID          = "90288f23-a593-4876-82a6-56f9b4448ac7"
LEAD_QUALIFIER_AGENT_ID      = "6403595f-6850-43c5-9f35-bba0a3e6a4e6"
OUTREACH_WRITER_AGENT_ID     = "77839380-ef3a-4f02-aa7f-6ef5e0e42b09"
SENDER_AGENT_ID              = "bc1948d9-53d9-4fc2-aafb-bfadc009332a"
TRACKER_AGENT_ID             = "6fcc7a88-4b5a-4a0e-bcc3-3489e7c8a90b"
GROWTH_COMPANY               = "14a23847-5215-44fc-8b2d-c45e25d3f291"
```

### Estado actual

- ✅ Lead Scout funcional (Google Maps Places API)
- ✅ Lead Qualifier funcional (scoring LLM)
- ✅ Outreach Writer funcional (email/WhatsApp/Instagram DM)
- ❌ Sender — esqueleto, pendiente implementar
- ❌ Tracker — esqueleto, pendiente implementar
- ⚠️ CEO tiene bug run_id (pendiente fix)

---

## Endpoints internos del servidor

```
GET /api/internal/seed-drops-agents?secret=<16chars>
GET /api/internal/seed-trading-agents?secret=<16chars>
GET /api/internal/seed-growth-agents?secret=<16chars>
GET /api/internal/seed-agents?secret=<16chars>          ← Discontrol Historys
GET /api/internal/list-companies?secret=<16chars>
GET /api/internal/list-projects?secret=<16chars>&companyId=...
GET /api/internal/list-recent-issues?secret=<16chars>&companyId=...
GET /api/internal/read-issue-comments?secret=<16chars>&issueId=...
GET /api/internal/fix-agent-timeout?id=<agentId>&timeoutSec=1800

POST /preview       → almacena HTML, devuelve {id, url}
GET  /preview/:id   → sirve el HTML (24h TTL)
GET  /sounds/:file  → success.m4a / error.m4a
GET  /terms, /privacy → páginas legales TikTok
```

`secret = BETTER_AUTH_SECRET[:16]`

---

## Patrón JWT para CEOs

```python
# CRÍTICO: usar PAPERCLIP_RUN_ID del env var (no inventar un run_id)
# activity_log.run_id tiene FK → heartbeat_runs.id
# Un run_id ficticio viola el constraint y da HTTP 500
payload = {
    "sub": agent_id,
    "company_id": company_id,
    "adapter_type": "process",
    "run_id": os.environ["PAPERCLIP_RUN_ID"],  # ← real, no ficticio
    ...
}
```

---

## APIs externas activas

| Servicio | Uso | Estado |
|---|---|---|
| OpenRouter | LLM (Haiku/Sonnet/Perplexity) | ✅ |
| Higgsfield | Popcorn + DoP Lite | ✅ |
| ElevenLabs | TTS narración | ✅ |
| YouTube Data API | Trends + canal stats | ✅ |
| Google Maps | Lead Scout | ✅ |
| Supabase | Content DB | ✅ |
| TikTok Content Posting | Auto-publisher | ⏳ App review |
| TikTok Research | Video data real | ⏳ Pendiente |

---

## Pendientes prioritarios

```
🔴 Fix run_id en CEO de Bags y Growth (mismo fix que Drops)
🟡 Sender agent (Growth) — para completar pipeline de captación
🟡 Telegram (Bags) — para alertas de trading
🟡 Shopify integration (Drops) — publicar productos directamente
🟢 TikTok OAuth — activar auto-publisher de vídeos
```

---

## Equipo

```
Alejandro  → Director técnico + content pipeline + infraestructura
Amigo 1    → DiscontrolsBags (Pine Script / TradingView strategies)
Amigo 2    → DiscontrolGrowth (ventas / captación de clientes)
Amir       → DiscontrolDrops (Shopify integration + dashboards frontend)
```

### DiscontrolsBags — CAMBIO IMPORTANTE

Ya NO es trading Polymarket. Ahora genera estrategias algorítmicas:
- Pipeline: Stock Analyzer → Strategy Designer → Strategy Critic → Strategy Optimizer → Reporter
- Output: Pine Script v5 listo para TradingView
- Input: ticker + estilo (momentum, breakout, mean_reversion, trend_following...)
- Reporter genera guía completa de uso en TradingView con backtesting

### DiscontrolDrops — Rol de Amir

- Integrar Shopify Admin API (publicar productos desde Web Designer)
- Implementar los 4 dashboards diseñados (ZIPs de Stitch en Downloads/)
- Gestionar tienda y primeros productos dropshipping
- Variables pendientes en Railway: SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN
