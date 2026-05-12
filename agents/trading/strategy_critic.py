"""
Agente: Strategy Critic
Revisa el Pine Script generado por el Strategy Designer y detecta
problemas lógicos, overfitting, look-ahead bias y sugiere mejoras.

Input: output del Strategy Designer (Pine Script + contexto).
Output: JSON compacto con critique (sin original_script — el CEO lo inyecta).
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

CRITIC_PROMPT = """Eres un revisor experto en Pine Script v5 y trading algorítmico.
Analiza el código y responde SOLO con JSON minificado (sin saltos de linea extra):

{{"q":"good|needs_improvement|poor","syn":["errores sintaxis Pine v5"],"log":["problemas logicos entrada/salida"],"la":false,"ov":"low|medium|high","rr":"ratio R:R ej 2:1","p":{{"param":valor}},"s":"resumen 1 oracion"}}

CODIGO:
{pine_code}

Solo JSON, sin explicaciones."""


def extract_pine_script(raw: str) -> str:
    if "```pine" in raw:
        return raw.split("```pine")[1].split("```")[0].strip()
    if "```" in raw:
        return raw.split("```")[1].split("```")[0].strip()
    return raw.strip()


def parse_response(response: str) -> dict:
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
    return {"q": "needs_improvement", "s": clean[:200]}


def main():
    print("🔍 Strategy Critic arrancando...", flush=True)
    os.environ["PAPERCLIP_COMPANY_ID"] = "866b74e7-79a7-4166-9f9f-025faa751aa1"
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", flush=True)
        post_issue_result("❌ Strategy Critic: OPENROUTER_API_KEY no configurada.")
        return

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    print(f"   Input: {len(raw)} chars", flush=True)

    pine_code = extract_pine_script(raw)
    print(f"   Pine Script extraído: {len(pine_code)} chars", flush=True)
    if not pine_code or len(pine_code) < 50:
        post_issue_result("❌ Strategy Critic: no se encontró Pine Script en el input.")
        return

    post_issue_comment("🔍 Strategy Critic — revisando calidad del Pine Script...")
    print(f"🔍 Revisando Pine Script ({len(pine_code)} chars)...", flush=True)

    response = call_llm(
        messages    = [{"role": "user", "content": CRITIC_PROMPT.format(pine_code=pine_code)}],
        api_key     = api_key,
        max_tokens  = 400,
        temperature = 0.1,
        title       = "StrategyCritic",
        model       = "anthropic/claude-haiku-4-5-20251001",
        timeout     = 60,
    )

    critique = parse_response(response)
    quality  = critique.get("q", critique.get("overall_quality", "needs_improvement"))
    print(f"  Calidad: {quality} | R:R: {critique.get('rr','N/A')} | Overfitting: {critique.get('ov','N/A')}", flush=True)

    # Output: solo JSON compacto, sin markdown ni original_script
    # (el CEO inyecta original_script directamente desde el Designer)
    post_issue_result(json.dumps(critique, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
