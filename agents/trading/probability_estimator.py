"""
Agente: Probability Estimator (Polymarket)
Usa LLM + noticias recientes para estimar la probabilidad real de un evento
y compararla con el precio actual del mercado.

Input (JSON del Market Scanner o manual):
{
  "question":  "¿Ganará X las elecciones?",
  "price_yes": 0.62,
  "end_date":  "2025-11-05",
  "category":  "politics"
}

Output: estimación de P(YES) con razonamiento + recomendación.
"""
import os
import sys
import json
import re
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

MIN_EDGE_POINTS = 0.07   # Edge mínimo para recomendar trade (7 puntos porcentuales)
MIN_CONFIDENCE  = "medium"

CRYPTO_SYMBOLS = {
    "bitcoin": "bitcoin", "btc": "bitcoin",
    "ethereum": "ethereum", "eth": "ethereum",
    "solana": "solana", "sol": "solana",
    "xrp": "XRP", "ripple": "XRP",
    "bnb": "BNB", "binance": "BNB",
    "doge": "dogecoin", "dogecoin": "dogecoin",
    "coinbase": "coinbase crypto",
    "crypto": "cryptocurrency",
}


def extract_crypto_query(question: str) -> str:
    """Extrae el término de búsqueda crypto más relevante de la pregunta."""
    q = question.lower()
    for keyword, symbol in CRYPTO_SYMBOLS.items():
        if keyword in q:
            return symbol
    return "cryptocurrency"


def fetch_google_news(query: str, max_items: int = 5) -> list[str]:
    """Obtiene titulares recientes de Google News RSS. Sin API key."""
    try:
        encoded = urllib.parse.quote(f"{query} price")
        url = f"https://news.google.com/rss/search?q={encoded}&hl=en&gl=US&ceid=US:en"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            xml_data = r.read().decode("utf-8", errors="replace")
        root = ET.fromstring(xml_data)
        titles = []
        for item in root.findall(".//item")[:max_items]:
            title = item.findtext("title", "").strip()
            pub   = item.findtext("pubDate", "")[:16]
            if title:
                titles.append(f"- {title} ({pub})")
        return titles
    except Exception as e:
        print(f"  ⚠️  Google News error: {e}", flush=True)
        return []


ESTIMATION_PROMPT = """Eres un analista experto en mercados de predicción (Polymarket).
Tu trabajo es estimar la probabilidad real de eventos y encontrar donde el mercado está equivocado.

MERCADO A ANALIZAR:
- Pregunta: {question}
- Precio actual YES: {price_yes:.0%} (= {price_yes:.0%} probabilidad implícita del mercado)
- Precio actual NO:  {price_no:.0%}
- Categoría: {category}
- Fecha resolución: {end_date}

NOTICIAS RECIENTES (últimas horas):
{news_section}

Analiza este mercado considerando:
1. ¿Qué indican las noticias recientes sobre la dirección del mercado?
2. ¿Cuál es la probabilidad base histórica para este tipo de evento?
3. ¿Hay sesgos conocidos en mercados de predicción (overconfidence, recency bias)?
4. ¿El precio actual refleja correctamente la incertidumbre dado el contexto actual?

IMPORTANTE: Sé conservador. Solo recomienda trade si tienes edge real y alta convicción.

Responde SOLO con JSON válido (sin markdown, sin texto extra):
{{
  "p_yes": 0.XX,
  "confidence": "high|medium|low",
  "reasoning": "explicación concisa de 2-3 oraciones",
  "key_factors": ["factor 1", "factor 2"],
  "edge_points": X.X,
  "recommendation": "BUY_YES|BUY_NO|PASS",
  "recommendation_reason": "por qué esta acción"
}}"""


def extract_params(raw: str) -> dict:
    """Extrae parámetros del input (JSON o texto libre)."""
    json_str = None
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
    elif raw.strip().startswith("{"):
        json_str = raw.strip()
    else:
        m = re.search(r'\{[\s\S]*?"question"[\s\S]*?\}', raw)
        if m:
            json_str = m.group(0)

    if json_str:
        try:
            data = json.loads(json_str)
            # Si viene lista de candidatos del Market Scanner, tomar el primero
            candidates = data.get("candidates", [])
            if candidates:
                data = candidates[0]
            return {
                "question":  data.get("question", raw[:200]),
                "price_yes": float(data.get("price_yes", 0.5)),
                "end_date":  data.get("end_date", ""),
                "category":  data.get("category", "general"),
                "condition_id": data.get("condition_id", ""),
            }
        except Exception as e:
            print(f"  ⚠️  JSON parse error: {e}", flush=True)

    return {
        "question":  raw.strip()[:300],
        "price_yes": 0.5,
        "end_date":  "",
        "category":  "general",
        "condition_id": "",
    }


def parse_llm_response(response: str) -> dict:
    """Extrae JSON de la respuesta del LLM."""
    # Limpiar posible markdown
    clean = response.strip()
    if "```json" in clean:
        clean = clean.split("```json")[1].split("```")[0].strip()
    elif "```" in clean:
        clean = clean.split("```")[1].split("```")[0].strip()
    try:
        return json.loads(clean)
    except Exception:
        # Intentar extraer JSON con regex
        m = re.search(r'\{[\s\S]*\}', clean)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return {}


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")

    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])

    if not raw:
        print("ERROR: Sin input", file=sys.stderr)
        sys.exit(1)

    post_issue_comment("📊 Probability Estimator analizando mercado con LLM...")

    params = extract_params(raw)
    price_yes = params["price_yes"]
    price_no  = 1 - price_yes

    print(f"🎯 Mercado: {params['question'][:80]}...", flush=True)
    print(f"📈 Precio YES: {price_yes:.0%} | NO: {price_no:.0%}", flush=True)

    # Buscar noticias recientes en Google News
    crypto_query = extract_crypto_query(params["question"])
    print(f"📰 Buscando noticias: '{crypto_query}'...", flush=True)
    headlines = fetch_google_news(crypto_query)
    if headlines:
        news_section = "\n".join(headlines)
        print(f"  → {len(headlines)} titulares obtenidos", flush=True)
    else:
        news_section = "No se pudieron obtener noticias recientes."
        print("  → Sin noticias disponibles", flush=True)

    prompt = ESTIMATION_PROMPT.format(
        question     = params["question"],
        price_yes    = price_yes,
        price_no     = price_no,
        category     = params["category"],
        end_date     = params["end_date"] or "No especificada",
        news_section = news_section,
    )

    response = call_llm(
        messages    = [{"role": "user", "content": prompt}],
        api_key     = api_key,
        max_tokens  = 600,
        temperature = 0.3,
        title       = "Polymarket Probability Estimator",
        model       = "anthropic/claude-3-5-haiku",
    )

    analysis = parse_llm_response(response)
    p_yes     = analysis.get("p_yes", price_yes)
    edge      = round(abs(p_yes - price_yes), 4)
    rec       = analysis.get("recommendation", "PASS")

    print(f"🤖 Estimación LLM: {p_yes:.0%}", flush=True)
    print(f"📊 Edge: {edge:.0%} | Recomendación: {rec}", flush=True)

    # Formatear output
    edge_emoji = "🟢" if edge >= MIN_EDGE_POINTS and rec != "PASS" else "🟡" if edge >= 0.04 else "🔴"
    lines = [f"# 📊 PROBABILITY ESTIMATOR — Polymarket\n"]
    lines.append(f"## Mercado\n**{params['question']}**\n")
    lines.append(f"| Métrica | Valor |")
    lines.append(f"|---|---|")
    lines.append(f"| Precio mercado YES | {price_yes:.0%} |")
    lines.append(f"| Estimación LLM | {p_yes:.0%} |")
    lines.append(f"| Edge | {edge_emoji} **{edge:.1%}** |")
    lines.append(f"| Confianza | {analysis.get('confidence', 'N/A')} |")
    lines.append(f"| Recomendación | **{rec}** |")
    lines.append("")
    lines.append(f"## Razonamiento\n{analysis.get('reasoning', response[:300])}\n")

    factors = analysis.get("key_factors", [])
    if factors:
        lines.append("## Factores clave")
        for f in factors:
            lines.append(f"- {f}")
        lines.append("")

    output_json = {
        "question":     params["question"],
        "price_yes":    price_yes,
        "p_yes_llm":    p_yes,
        "edge":         edge,
        "confidence":   analysis.get("confidence", "low"),
        "recommendation": rec,
        "reasoning":    analysis.get("reasoning", ""),
        "condition_id": params.get("condition_id", ""),
        "tradeable":    edge >= MIN_EDGE_POINTS and rec != "PASS",
    }
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    output = "\n".join(lines)
    post_issue_result(output)


if __name__ == "__main__":
    main()
