---
name: amir-drops
description: >
  Contexto para Amir — DiscontrolDrops (Shopify + Dashboards).
  Úsala cuando Amir trabaje en la integración con Shopify o en la
  implementación de los dashboards visuales de DiscontrolDrops.
---

# Amir — DiscontrolDrops

## Tu misión

Tienes dos áreas principales:
1. **Shopify** — conectar el pipeline de Drops para publicar productos automáticamente
2. **Dashboards** — implementar los diseños visuales ya creados

---

## El pipeline que ya funciona (no toques estos archivos)

```
CEO → Product Hunter → Ad Spy → Lead Qualifier → Web Designer → Marketing Creator
```

El pipeline ya genera:
- Lista de productos analizados con scores
- Validación de demanda (YouTube, Google Trends, Google Shopping)
- Estructura de landing page Shopify + preview HTML
- Copy de anuncios, scripts TikTok, emails

**Lo que falta:** que el Web Designer publique el producto directamente en Shopify
en vez de solo mostrar el preview.

---

## Tarea 1 — Shopify Integration

### Variables que necesitas añadir en Railway

```
SHOPIFY_STORE_URL=tu-tienda.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxx
```

Para obtenerlas:
1. Crea cuenta en Shopify (plan básico ~$29/mes)
2. Settings → Apps → Develop apps → Create app
3. Permisos necesarios: Products (R/W), Pages (R/W), Orders (R)
4. Admin API Access Token → copiarlo a Railway

### Archivo a modificar

`agents/drops/web_designer.py` — al final del main(), después de generar el HTML,
añadir función `publish_to_shopify(product, html_content, api_url, token)` que:
- Cree el producto en Shopify con título, descripción, precio
- Cree una página con el HTML de la landing
- Devuelva las URLs del producto publicado

### Shopify Admin API endpoints útiles

```
POST /admin/api/2024-01/products.json       → crear producto
POST /admin/api/2024-01/pages.json          → crear página landing
PUT  /admin/api/2024-01/products/{id}.json  → actualizar producto
```

---

## Tarea 2 — Implementar Dashboards

Tienes 4 diseños ya listos en ZIPs (en Downloads/ de Alejandro):

| Dashboard | ZIP | Colores |
|---|---|---|
| DiscontrolDrops | stitch_discontroldrops_ai_dashboard.zip | Naranja #f97316 |
| DiscontrolsBags | stitch_discontrolsbags_ai_engine.zip | Púrpura #a855f7 |
| DiscontrolGrowth | stitch_discontrolgrowth_sales_dashboard (2).zip | Verde #22c55e |
| DiscontrolCreator | stitch_discontrol_creator_web (1).zip | Ya implementado |

### Por dónde empezar

1. Descomprime `stitch_discontroldrops_ai_dashboard.zip`
2. Abre los HTML en VS Code
3. Conecta el dashboard al backend de Paperclip:
   - `GET /api/companies/{companyId}/issues` → últimas tareas del CEO
   - `GET /api/companies/{companyId}/agents` → estado de agentes
4. Sube a Vercel o Railway como nueva ruta

### Company ID de DiscontrolDrops

```
0b4751e7-24e7-4e8b-98e0-5b5ed73b6d7c
```

---

## Archivos que puedes tocar

```
✅ agents/drops/web_designer.py   → añadir Shopify publish
✅ Cualquier dashboard HTML nuevo
✅ skills/drops/               → skills de los agentes
```

## Archivos que NO debes tocar

```
❌ agents/drops/ceo.py
❌ agents/api_client.py
❌ server/src/app.ts
❌ frontend/index.html
❌ agents/director.py
```

---

## Cómo trabajar con Git

Siempre en tu rama:
```bash
git checkout -b feat/amir
```

Nunca tocar master directamente. Cuando tengas algo listo, avisa a Alejandro.

---

## Contexto del servidor

```
URL pública: https://spirited-charm-production.up.railway.app
Preview HTML: https://spirited-charm-production.up.railway.app/preview/{id}
```

Para más contexto del ecosistema completo, lee:
`.claude/skills/diskontrol-ecosystem/SKILL.md`
