"""
Agente: Lead Qualifier — DiscontrolDrops
Puntúa y califica productos para dropshipping usando LLM.
Combina datos del Product Hunter + Ad Spy para dar un score final.

Input (JSON del Product Hunter + Ad Spy):
{
  "products": [...],    # del Product Hunter
  "ad_results": [...],  # del Ad Spy (opcional)
  "niche": "..."
}

Output: ranking de productos con score 0-100 y recomendación clara.
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


QUALIFIER_SYSTEM = """Eres el mejor analista de dropshipping con Shopify para el mercado español y europeo.
Tu trabajo: calificar productos con un score real basado en datos concretos.

CRITERIOS DE SCORING (100 puntos total):
- Margen potencial (>60% = 25pts, 40-60% = 15pts, <40% = 5pts)
- Validación de demanda (anuncios activos FB = 20pts)
- Nivel de competencia (Low = 20pts, Med = 10pts, High = 5pts)
- Facilidad de venta en España/LATAM (15pts)
- Originalidad del ángulo disponible (10pts)
- Facilidad logística / tiempo de envío (10pts)

REGLAS:
- Score > 75: LAUNCH — lanzar ahora
- Score 50-74: TEST — probar con presupuesto bajo
- Score < 50: SKIP — no vale la pena

Responde SOLO con JSON válido."""


def qualify_products(products: list, ad_results: list, niche: str, api_key: str) -> list:
    """Califica todos los productos con LLM."""
    # Construir contexto combinado
    products_context = []
    ad_map = {r["product"]: r for r in ad_results} if ad_results else {}

    for p in products[:12]:
        name    = p.get("name", p.get("term", "?"))
        ad_data = ad_map.get(name, {})

        entry = {
            "name":             name,
            "est_margin_pct":   p.get("est_margin_pct", "?"),
            "competition":      p.get("competition", ad_data.get("insights", {}).get("competition_level", "?")),
            "suggested_price":  p.get("suggested_price_eur", "?"),
            "supplier_cost":    p.get("supplier_est_cost_eur", "?"),
            "fb_ads_active":    ad_data.get("total_ads", 0),
            "fb_validated":     ad_data.get("validated", False),
            "dominant_angle":   ad_data.get("insights", {}).get("dominant_angle", ""),
            "why":              p.get("why", ""),
            "target_audience":  p.get("target_audience", ""),
        }
        products_context.append(entry)

    niche_core = niche.split("(")[0].split("—")[0].split("\n")[0].strip()

    prompt = f"""Califica estos productos para dropshipping en el nicho "{niche_core}" para el mercado español.

⚠️ REGLA DE VALIDACIÓN: Antes de calificar, verifica que cada producto pertenece al nicho "{niche_core}".
Si un producto NO es del nicho (ej: nicho=mascotas pero el producto es un ventilador de cuello), asígnale score=0, recommendation=SKIP y key_strength="Producto fuera del nicho".
Solo califica productos directamente relacionados con "{niche_core}".

PRODUCTOS A CALIFICAR:
{json.dumps(products_context, indent=2, ensure_ascii=False)}

Para cada producto devuelve un score detallado y recomendación.
Responde SOLO con JSON:
{{
  "qualified": [
    {{
      "name": "nombre",
      "final_score": 82,
      "recommendation": "LAUNCH|TEST|SKIP",
      "score_breakdown": {{
        "margin": 25,
        "demand_validation": 20,
        "competition": 15,
        "spain_fit": 12,
        "angle_opportunity": 7,
        "logistics": 3
      }},
      "key_strength": "su mayor ventaja en 1 frase",
      "main_risk": "su mayor riesgo en 1 frase",
      "suggested_hook": "el hook de anuncio más potente en español (máx 10 palabras)",
      "suggested_price_eur": 39.99,
      "supplier_cost_eur": 8.50,
      "est_margin_pct": 65,
      "est_monthly_revenue_eur": 2400,
      "image_url": "copia EXACTA del campo image_url del producto original si existe, si no deja vacío",
      "cj_url": "copia EXACTA del campo cj_url del producto original si existe, si no deja vacío"
    }}
  ]
}}"""

    try:
        response = call_llm(
            messages=[
                {"role": "system", "content": QUALIFIER_SYSTEM},
                {"role": "user",   "content": prompt},
            ],
            api_key     = api_key,
            max_tokens  = 4000,
            temperature = 0.3,
            title       = "DiscontrolDrops - Lead Qualifier",
            model       = "anthropic/claude-sonnet-4-5",
            timeout     = 90,
            retries     = 1,
        )
        clean = response.strip()
        if "```json" in clean:
            clean = clean.split("```json")[1].split("```")[0].strip()
        elif "```" in clean:
            clean = clean.split("```")[1].split("```")[0].strip()
        data = json.loads(clean)
        qualified = data.get("qualified", [])
        # Ordenar por score
        qualified.sort(key=lambda x: x.get("final_score", 0), reverse=True)
        return qualified
    except Exception as e:
        print(f"  ⚠️  Qualification error: {type(e).__name__}: {e}", flush=True)
        print(f"  ⚠️  LLM response was ({len(response) if 'response' in dir() else 0} chars): {response[:200] if 'response' in dir() else 'N/A'}", flush=True)
        return []


def extract_input(raw: str) -> tuple:
    """Extrae productos, ad_results y nicho del input."""
    json_str = None
    if "```json" in raw:
        # Tomar el último bloque JSON (puede haber varios del Hunter + Ad Spy)
        blocks = raw.split("```json")
        for block in reversed(blocks[1:]):
            candidate = block.split("```")[0].strip()
            try:
                data = json.loads(candidate)
                if "products" in data or "qualified" in data:
                    json_str = candidate
                    break
            except Exception:
                continue
    elif raw.strip().startswith("{"):
        json_str = raw.strip()

    if json_str:
        try:
            data = json.loads(json_str)
            return (
                data.get("products", []),
                data.get("results", data.get("ad_results", [])),
                data.get("niche", data.get("query", "products")),
            )
        except Exception:
            pass
    return [], [], raw.strip()


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        post_issue_result("❌ Lead Qualifier: OPENROUTER_API_KEY no configurada.")
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    if not raw:
        raw = "tactical gadgets"

    products, ad_results, niche = extract_input(raw)

    if not products:
        post_issue_result("❌ Lead Qualifier: No se encontraron productos. Pasa el output del Product Hunter.")
        return

    post_issue_comment(
        f"🎯 Lead Qualifier calificando **{len(products)} productos**...\n\n"
        f"Analizando margen, demanda, competencia y fit para España."
    )
    print(f"🎯 Calificando {len(products)} productos para nicho: '{niche}'", flush=True)

    qualified = qualify_products(products, ad_results, niche, api_key)

    if not qualified:
        post_issue_result("❌ Lead Qualifier: No se pudo calificar los productos.")
        return

    print(f"✅ {len(qualified)} productos calificados", flush=True)

    lines = [f"# 🎯 LEAD QUALIFIER — {niche.title()}\n"]

    launch = [p for p in qualified if p.get("recommendation") == "LAUNCH"]
    test   = [p for p in qualified if p.get("recommendation") == "TEST"]
    skip   = [p for p in qualified if p.get("recommendation") == "SKIP"]

    lines.append(f"**{len(launch)} LAUNCH · {len(test)} TEST · {len(skip)} SKIP**\n")

    # Mostrar LAUNCH primero
    for section, items, emoji in [("🟢 LAUNCH — Lanzar ahora", launch, "🟢"),
                                    ("🟡 TEST — Probar con bajo presupuesto", test, "🟡"),
                                    ("🔴 SKIP — No recomendado", skip[:3], "🔴")]:
        if not items:
            continue
        lines.append(f"## {section}\n")
        for p in items:
            score    = p.get("final_score", "?")
            name     = p.get("name", "?")
            strength = p.get("key_strength", "")
            risk     = p.get("main_risk", "")
            hook     = p.get("suggested_hook", "")
            revenue  = p.get("est_monthly_revenue_eur", "?")
            bd       = p.get("score_breakdown", {})

            lines.append(f"### {emoji} {name} — Score: **{score}/100**")
            if strength: lines.append(f"✅ **Fortaleza:** {strength}")
            if risk:     lines.append(f"⚠️ **Riesgo:** {risk}")
            if hook:     lines.append(f"🎣 **Hook:** *\"{hook}\"*")
            if revenue:  lines.append(f"💶 **Revenue estimado/mes:** €{revenue:,}" if isinstance(revenue, (int,float)) else f"💶 **Revenue estimado/mes:** {revenue}")
            if bd:
                lines.append(f"📊 Desglose: Margen {bd.get('margin',0)}pts · Demanda {bd.get('demand_validation',0)}pts · Competencia {bd.get('competition',0)}pts")
            lines.append("")

    output_json = {
        "qualified": qualified,
        "niche":     niche,
        "summary":   {"launch": len(launch), "test": len(test), "skip": len(skip)},
        "top_pick":  qualified[0] if qualified else None,
    }
    json_block = "```json\n" + json.dumps(output_json, indent=2, ensure_ascii=False) + "\n```"

    # JSON PRIMERO — así el CEO puede parsearlo aunque el output sea truncado
    output = json_block + "\n\n" + "\n".join(lines)
    print(output[:500], flush=True)
    post_issue_result(output)


if __name__ == "__main__":
    main()
