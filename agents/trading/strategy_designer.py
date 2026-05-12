"""
Agente: Strategy Designer
Recibe el análisis técnico de un stock y usa LLM para generar
una estrategia completa en Pine Script v5 lista para TradingView.

Input (JSON del Stock Analyzer): datos técnicos del ticker.
Output: Pine Script v5 + explicación de la lógica.
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

DESIGN_PROMPT = """Eres un experto en trading algorítmico y Pine Script v5 para TradingView.
Tu objetivo es diseñar una estrategia de trading sólida para el siguiente stock.

DATOS DEL STOCK:
- Ticker: {ticker}
- Precio actual: ${current_price}
- Tendencia: {trend}
- ATR 14: ${atr_14} (volatilidad diaria media)
- SMA 20: ${sma20} | SMA 50: ${sma50} | SMA 200: ${sma200}
- Volatilidad anual: {volatility}%
- Cambio 3M: {change_3m}%
- Volumen medio 20d: {avg_volume}

ESTILO DE ESTRATEGIA SOLICITADO: {style}

INSTRUCCIONES:
Genera un Pine Script v5 COMPLETO y funcional para TradingView con:

1. Cabecera: //@version=6 y strategy() con:
   - title descriptivo (shorttitle máximo 10 caracteres)
   - commission_type=strategy.commission.percent, commission_value=0.1
   - slippage=2
   - initial_capital=10000
   - default_qty_type=strategy.percent_of_equity, default_qty_value=10

2. INPUTS configurables por el usuario (al menos 3 parámetros clave)

3. INDICADORES apropiados para el estilo "{style}" y las características del stock
   (usa el ATR de ${atr_14} como referencia para stop-loss)

4. CONDICIONES DE ENTRADA (long y/o short) claras y sin look-ahead bias

5. CONDICIONES DE SALIDA:
   - Stop-loss basado en ATR (multiplicador como input)
   - Take-profit con ratio riesgo/recompensa mínimo 2:1
   - Opcionalmente: trailing stop o salida por indicador

6. VISUALIZACIÓN: plot() de los indicadores principales

El código debe ser válido Pine Script v5, sin errores de compilación.
Solo devuelve el código Pine Script, sin explicaciones fuera del código.
Incluye comentarios dentro del código explicando cada sección."""


def extract_stock_data(raw: str) -> dict:
    """Extrae el JSON de análisis del Stock Analyzer."""
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
    else:
        m = re.search(r'\{[\s\S]*?"ticker"[\s\S]*?\}', raw)
        json_str = m.group(0) if m else raw.strip()
    try:
        return json.loads(json_str)
    except Exception:
        return {}


def main():
    print("🎨 Strategy Designer arrancando...", flush=True)
    os.environ["PAPERCLIP_COMPANY_ID"] = "866b74e7-79a7-4166-9f9f-025faa751aa1"
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", flush=True)
        post_issue_result("❌ Strategy Designer: OPENROUTER_API_KEY no configurada.")
        return

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    print(f"   Input: {len(raw)} chars", flush=True)

    data = extract_stock_data(raw)
    print(f"   Ticker extraído: {data.get('ticker', 'NONE')}", flush=True)
    if not data.get("ticker"):
        post_issue_result("❌ Strategy Designer: no se pudo leer los datos del Stock Analyzer.")
        return

    ticker    = data.get("ticker", "STOCK")
    style     = data.get("style", "momentum")
    post_issue_comment(f"🎨 Strategy Designer — diseñando estrategia `{style}` para `{ticker}`...")

    print(f"🎯 Diseñando estrategia {style} para {ticker}...", flush=True)

    prompt = DESIGN_PROMPT.format(
        ticker       = ticker,
        current_price = data.get("current_price", "N/A"),
        trend        = data.get("trend", "neutral"),
        atr_14       = data.get("atr_14", "N/A"),
        sma20        = data.get("sma20", "N/A"),
        sma50        = data.get("sma50", "N/A"),
        sma200       = data.get("sma200", "N/A"),
        volatility   = data.get("volatility_annual_pct", "N/A"),
        change_3m    = data.get("change_3m_pct", "N/A"),
        avg_volume   = f"{data.get('avg_volume_20d', 0):,}" if data.get("avg_volume_20d") else "N/A",
        style        = style,
    )

    response = call_llm(
        messages    = [{"role": "user", "content": prompt}],
        api_key     = api_key,
        max_tokens  = 2000,
        temperature = 0.4,
        title       = f"StrategyDesigner-{ticker}",
        model       = "anthropic/claude-3-5-haiku",
        timeout     = 90,
    )

    print(f"  ✅ Pine Script generado ({len(response)} chars)", flush=True)

    # Extraer solo el bloque de código si viene con markdown
    pine_code = response.strip()
    if "```pine" in pine_code:
        pine_code = pine_code.split("```pine")[1].split("```")[0].strip()
    elif "```" in pine_code:
        pine_code = pine_code.split("```")[1].split("```")[0].strip()

    lines = [f"# 🎨 STRATEGY DESIGNER — {ticker} ({style})\n"]
    lines.append(f"Estrategia generada para **{ticker}** | Estilo: `{style}` | Tendencia: `{data.get('trend', 'N/A')}`\n")
    lines.append("```pine")
    lines.append(pine_code)
    lines.append("```")
    lines.append("\n---")
    lines.append(f"_Stock Analyzer data: ATR={data.get('atr_14')} | SMA50={data.get('sma50')} | Vol={data.get('volatility_annual_pct')}%_")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
