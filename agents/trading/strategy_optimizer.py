"""
Agente: Strategy Optimizer
Recibe el Pine Script original + la crítica del Strategy Critic
y usa LLM para reescribir la estrategia corrigiendo los problemas.

Input: output del Strategy Critic (JSON con critique + original_script).
Output: Pine Script v5 refinado y comentado.
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

OPTIMIZER_PROMPT = """Eres un experto en Pine Script v5 y trading algorítmico.
Debes mejorar la siguiente estrategia aplicando las correcciones indicadas en la crítica.

ESTRATEGIA ORIGINAL:
{original_script}

CRÍTICA Y MEJORAS SOLICITADAS:
- Calidad actual: {quality}
- Errores de sintaxis: {syntax_issues}
- Problemas lógicos: {logic_issues}
- Look-ahead bias: {lookahead}
- Riesgo de overfitting: {overfitting}
- Parámetros sugeridos: {params}
- Resumen: {summary}

INSTRUCCIONES:
1. Corrige TODOS los errores de sintaxis
2. Soluciona los problemas lógicos señalados
3. Elimina cualquier look-ahead bias si existe
4. Aplica los parámetros sugeridos como nuevos valores por defecto
5. Añade comentarios claros en cada sección del código
6. Mantén la estructura y el estilo de la estrategia original
7. Asegúrate de que el código compila sin errores en TradingView

Devuelve SOLO el código Pine Script v5 mejorado, sin texto adicional fuera del código."""


def extract_critique(raw: str) -> dict:
    """Extrae el JSON de critique del Strategy Critic."""
    # 1. Buscar bloque ```json
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
        try:
            data = json.loads(json_str)
            if data.get("original_script"):
                return data
        except Exception:
            pass

    # 2. Buscar JSON inline con overall_quality
    m = re.search(r'\{[\s\S]*?"overall_quality"[\s\S]*?\}', raw)
    if m:
        try:
            data = json.loads(m.group(0))
            if data.get("original_script"):
                return data
        except Exception:
            pass

    # 3. Buscar Pine Script directamente en el texto (el Critic lo incluye en el JSON)
    # Intentar extraer original_script del JSON aunque esté truncado
    m2 = re.search(r'"original_script"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)', raw)
    if m2:
        pine = m2.group(1).replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
        if len(pine) >= 50:
            return {"original_script": pine, "overall_quality": "needs_improvement"}

    # 4. Fallback: bloque ```pine o primer bloque de código
    pine = ""
    if "```pine" in raw:
        pine = raw.split("```pine")[1].split("```")[0].strip()
    elif "```" in raw:
        for block in raw.split("```")[1::2]:
            candidate = block.strip()
            if len(candidate) >= 50 and "//@version" in candidate:
                pine = candidate
                break
    return {"original_script": pine, "overall_quality": "needs_improvement"}


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")

    critique = extract_critique(raw)
    original = critique.get("original_script", "")

    if not original or len(original) < 50:
        post_issue_result("❌ Strategy Optimizer: no se encontró el Pine Script original en el input.")
        sys.exit(1)

    # Soporta tanto claves largas (legacy) como cortas (nuevo Critic compacto)
    quality = critique.get("q", critique.get("overall_quality", "needs_improvement"))
    post_issue_comment(f"⚙️ Strategy Optimizer — refinando estrategia (calidad base: `{quality}`)...")
    print(f"⚙️ Optimizando Pine Script ({len(original)} chars)...", flush=True)

    params_str = json.dumps(critique.get("p", critique.get("parameter_suggestions", {})), ensure_ascii=False)
    prompt = OPTIMIZER_PROMPT.format(
        original_script = original,
        quality         = quality,
        syntax_issues   = "; ".join(critique.get("syn", critique.get("syntax_issues", [])) or ["Ninguno"]),
        logic_issues    = "; ".join(critique.get("log", critique.get("logic_issues", [])) or ["Ninguno"]),
        lookahead       = critique.get("lookahead_explanation", "Ninguno detectado"),
        overfitting     = critique.get("ov", critique.get("overfitting_risk", "unknown")),
        params          = params_str,
        summary         = critique.get("s", critique.get("summary", "")),
    )

    response = call_llm(
        messages    = [{"role": "user", "content": prompt}],
        api_key     = api_key,
        max_tokens  = 2000,
        temperature = 0.3,
        title       = "StrategyOptimizer",
        model       = "anthropic/claude-sonnet-4-6",
        timeout     = 90,
    )

    # Extraer el código Pine Script
    pine_optimized = response.strip()
    if "```pine" in pine_optimized:
        pine_optimized = pine_optimized.split("```pine")[1].split("```")[0].strip()
    elif "```" in pine_optimized:
        pine_optimized = pine_optimized.split("```")[1].split("```")[0].strip()

    print(f"  ✅ Pine Script optimizado ({len(pine_optimized)} chars)", flush=True)

    changes = []
    syn = critique.get("syn", critique.get("syntax_issues", []))
    log = critique.get("log", critique.get("logic_issues", []))
    if syn:
        changes.append(f"✅ {len(syn)} errores de sintaxis corregidos")
    if log:
        changes.append(f"✅ {len(log)} problemas lógicos resueltos")
    if critique.get("la", critique.get("lookahead_bias")):
        changes.append("✅ Look-ahead bias eliminado")
    if critique.get("p", critique.get("parameter_suggestions")):
        changes.append(f"✅ parámetros optimizados")

    lines = ["# ⚙️ STRATEGY OPTIMIZER — Pine Script Refinado\n"]
    if changes:
        lines.append("## Mejoras aplicadas")
        for c in changes:
            lines.append(f"- {c}")
        lines.append("")
    lines.append("```pine")
    lines.append(pine_optimized)
    lines.append("```")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
