"""
Agente: Strategy Critic
Revisa el Pine Script generado por el Strategy Designer y detecta
problemas lógicos, overfitting, look-ahead bias y sugiere mejoras.

Input: output del Strategy Designer (Pine Script + contexto).
Output: JSON con lista de issues + sugerencias de parámetros.
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

CRITIC_PROMPT = """Eres un revisor experto en estrategias de trading algorítmico y Pine Script v5.
Analiza el siguiente código Pine Script y evalúa su calidad.

CÓDIGO A REVISAR:
{pine_code}

Evalúa los siguientes aspectos y responde SOLO con JSON válido:

{{
  "syntax_issues": ["lista de errores de sintaxis Pine Script v5, si los hay"],
  "logic_issues": ["problemas con la lógica de entrada/salida"],
  "lookahead_bias": true/false,
  "lookahead_explanation": "explicación si hay bias, o 'Ninguno detectado'",
  "overfitting_risk": "low|medium|high",
  "overfitting_reason": "por qué",
  "risk_reward_ratio": "estimación del ratio R:R (ej: '2:1')",
  "parameter_suggestions": {{
    "nombre_param": valor_sugerido
  }},
  "overall_quality": "good|needs_improvement|poor",
  "summary": "resumen en 2 oraciones de los puntos más importantes",
  "original_script": "el Pine Script original sin modificar"
}}

Sé específico y accionable. Si el código es bueno, dilo claramente."""


def extract_pine_script(raw: str) -> str:
    """Extrae el bloque Pine Script del input."""
    if "```pine" in raw:
        return raw.split("```pine")[1].split("```")[0].strip()
    if "```" in raw:
        return raw.split("```")[1].split("```")[0].strip()
    return raw.strip()


def parse_critic_response(response: str) -> dict:
    clean = response.strip()
    if "```json" in clean:
        clean = clean.split("```json")[1].split("```")[0].strip()
    elif "```" in clean:
        clean = clean.split("```")[1].split("```")[0].strip()
    try:
        return json.loads(clean)
    except Exception:
        m = re.search(r'\{[\s\S]*\}', clean)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return {"overall_quality": "needs_improvement", "summary": response[:300]}


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")

    pine_code = extract_pine_script(raw)
    if not pine_code or len(pine_code) < 50:
        post_issue_result("❌ Strategy Critic: no se encontró código Pine Script en el input.")
        sys.exit(1)

    post_issue_comment("🔍 Strategy Critic — revisando lógica y calidad del Pine Script...")
    print(f"🔍 Revisando Pine Script ({len(pine_code)} chars)...", flush=True)

    prompt = CRITIC_PROMPT.format(pine_code=pine_code)

    response = call_llm(
        messages    = [{"role": "user", "content": prompt}],
        api_key     = api_key,
        max_tokens  = 1200,
        temperature = 0.2,
        title       = "StrategyCritic",
        model       = "anthropic/claude-haiku-4-5-20251001",
        timeout     = 60,
    )

    critique = parse_critic_response(response)
    critique["original_script"] = pine_code
    quality  = critique.get("overall_quality", "needs_improvement")

    quality_emoji = {"good": "✅", "needs_improvement": "🟡", "poor": "🔴"}.get(quality, "🟡")
    print(f"  {quality_emoji} Calidad: {quality}", flush=True)
    print(f"  R:R: {critique.get('risk_reward_ratio', 'N/A')}", flush=True)
    print(f"  Overfitting: {critique.get('overfitting_risk', 'N/A')}", flush=True)

    lines = [f"# 🔍 STRATEGY CRITIC — Revisión\n"]
    lines.append(f"**Calidad:** {quality_emoji} `{quality}` | **R:R:** {critique.get('risk_reward_ratio', 'N/A')} | **Overfitting:** {critique.get('overfitting_risk', 'N/A')}\n")
    lines.append(f"_{critique.get('summary', '')}_\n")

    syntax = critique.get("syntax_issues", [])
    logic  = critique.get("logic_issues", [])
    if syntax:
        lines.append("## ⚠️ Errores de sintaxis")
        for s in syntax:
            lines.append(f"- {s}")
        lines.append("")
    if logic:
        lines.append("## 🔧 Problemas lógicos")
        for l in logic:
            lines.append(f"- {l}")
        lines.append("")

    params = critique.get("parameter_suggestions", {})
    if params:
        lines.append("## 🎛️ Parámetros sugeridos")
        for k, v in params.items():
            lines.append(f"- `{k}` → `{v}`")
        lines.append("")

    lines.append("```json")
    lines.append(json.dumps(critique, indent=2, ensure_ascii=False))
    lines.append("```")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
