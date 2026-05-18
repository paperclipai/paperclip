"""
Agente: Marketing Creator — DiscontrolDrops
Genera todos los assets de marketing para lanzar el producto:
ad copy, video scripts, descripción Shopify y emails.

Skills usadas (fetch dinámico desde Paperclip):
  - ads-copywriter    → límites de caracteres por plataforma + A/B testing
  - marketing-creator → guidelines generales del agente
"""
import os, sys, json
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm, fetch_skill
sys.stdout.reconfigure(encoding="utf-8")

DROPS_COMPANY = "0b4751e7-24e7-4e8b-98e0-5b5ed73b6d7c"

BASE_SYSTEM = """Eres el mejor copywriter de dropshipping para el mercado español y latinoamericano.
Escribes copy que convierte: directo, emocional, con prueba social y urgencia real.
Conoces los formatos de Facebook Ads, TikTok y Shopify a la perfección.
Todo en español neutro (funciona en ES y LATAM)."""


def extract_top_product(raw: str) -> dict:
    try:
        for block in reversed(raw.split("```json")[1:]):
            try:
                data = json.loads(block.split("```")[0].strip())
                if data.get("top_pick"):  return data["top_pick"]
                if data.get("qualified"): return data["qualified"][0]
                if data.get("name"):      return data
            except Exception:
                continue
    except Exception:
        pass
    return {"name": raw[:100]}


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        post_issue_result("❌ Marketing Creator: OPENROUTER_API_KEY no configurada.")
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw     = issue_body if issue_body else (issue_title or "")
    product = extract_top_product(raw)
    name     = product.get("name", "el producto")
    hook     = product.get("suggested_hook", "")
    price    = product.get("suggested_price_eur", "?")
    audience = product.get("target_audience", "adultos 25-45")
    strength = product.get("key_strength", "")
    risk     = product.get("main_risk", "")

    post_issue_comment(f"📣 Marketing Creator cargando skills y generando assets para: **{name}**")

    # ── Fetch skills dinámicamente desde Paperclip ────────────────────────────
    print("📚 Cargando skills desde Paperclip...", flush=True)
    skill_ads      = fetch_skill("ads-copywriter",    company_id=DROPS_COMPANY)
    skill_marketing = fetch_skill("marketing-creator", company_id=DROPS_COMPANY)

    # Construir system prompt enriquecido con las skills
    system_parts = [BASE_SYSTEM]
    if skill_ads:
        # Extraer solo la sección de specs de plataforma (evitar metadata YAML)
        ads_content = skill_ads
        if "# Ads Copywriter" in ads_content:
            ads_content = ads_content.split("# Ads Copywriter")[1][:3000]
        system_parts.append(f"\n\n--- PLATFORM SPECS (ads-copywriter skill) ---\n{ads_content}")
    if skill_marketing:
        marketing_content = skill_marketing
        if "---" in marketing_content:
            parts = marketing_content.split("---")
            marketing_content = "---".join(parts[2:])[:2000] if len(parts) > 2 else marketing_content[:2000]
        system_parts.append(f"\n\n--- MARKETING GUIDELINES ---\n{marketing_content}")

    system_prompt = "\n".join(system_parts)
    print(f"  ✅ System prompt: {len(system_prompt)} chars", flush=True)

    # ── Generar assets ────────────────────────────────────────────────────────
    prompt = f"""Genera todos los assets de marketing para este producto de dropshipping:

Producto: {name}
Precio: €{price}
Audiencia: {audience}
Hook base: {hook}
Fortaleza: {strength}
Riesgo a superar: {risk}

IMPORTANTE: Respeta los límites de caracteres por plataforma de las specs.

## 1. FACEBOOK / INSTAGRAM ADS (3 variantes A/B)
Para cada variante:
- Primary Text: máx 125 chars visibles (500 total)
- Headline: máx 40 chars
- CTA button: [Comprar ahora / Ver más / Obtener oferta]

## 2. TIKTOK / REELS SCRIPTS (2 scripts de 30 segundos)
Formato: [0-3s HOOK] [3-15s DEMO/PROBLEMA] [15-25s BENEFICIO] [25-30s CTA]
Caption: máx 2200 chars, primera línea visible máx 100 chars

## 3. DESCRIPCIÓN SHOPIFY
Headline emocional (máx 8 palabras) + 5 bullets beneficios + garantía + urgencia

## 4. EMAIL SECUENCIA (3 emails)
- Email 1 (día 0): Confirmación + expectativas
- Email 2 (día 3): Consejos de uso + upsell suave
- Email 3 (día 7): Solicitud reseña + descuento 10%

## 5. HOOKS TIKTOK (8 hooks de 3 segundos)
Frases de apertura que paran el scroll. Máx 100 chars cada una.

## 6. GOOGLE ADS (3 headlines + 2 descriptions)
- Headlines: máx 30 chars cada una
- Descriptions: máx 90 chars cada una

Todo en español. Copy real, listo para publicar."""

    try:
        response = call_llm(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": prompt}
            ],
            api_key    = api_key,
            max_tokens = 4000,
            temperature = 0.75,
            title      = "DiscontrolDrops - Marketing Creator",
            model      = "anthropic/claude-sonnet-4-5",
            timeout    = 60,
            retries    = 1,
        )
        output = f"# 📣 MARKETING ASSETS — {name}\n\n{response}"
        post_issue_result(output)

    except Exception as e:
        post_issue_result(f"❌ Marketing Creator error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
