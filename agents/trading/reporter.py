"""
Agente: Reporter
Compila el Pine Script final y genera un reporte completo con
instrucciones de uso en TradingView listo para el usuario.

Input: output del Strategy Optimizer (Pine Script refinado).
Output: reporte final con Pine Script + guía de uso en TradingView.
"""
import os
import sys
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def extract_pine_script(raw: str) -> str:
    if "```pine" in raw:
        return raw.split("```pine")[1].split("```")[0].strip()
    if "```" in raw:
        return raw.split("```")[1].split("```")[0].strip()
    return raw.strip()


def extract_strategy_title(pine_code: str) -> str:
    m = re.search(r'strategy\s*\(\s*["\']([^"\']+)["\']', pine_code)
    return m.group(1) if m else "Estrategia de Trading"


def extract_inputs(pine_code: str) -> list[str]:
    return re.findall(r'(\w+)\s*=\s*input\.[^(]+\([^)]*title\s*=\s*["\']([^"\']+)["\']', pine_code)


def main():
    os.environ["PAPERCLIP_COMPANY_ID"] = "866b74e7-79a7-4166-9f9f-025faa751aa1"
    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")

    pine_code = extract_pine_script(raw)
    if not pine_code or len(pine_code) < 50:
        post_issue_result("❌ Reporter: no se encontró Pine Script en el input del Optimizer.")
        sys.exit(1)

    post_issue_comment("📋 Reporter — compilando reporte final...")

    strategy_title = extract_strategy_title(pine_code)
    print(f"📋 Generando reporte para: '{strategy_title}'", flush=True)

    lines = [f"# 📊 ESTRATEGIA LISTA — {strategy_title}\n"]
    lines.append("> ⚠️ **Uso educativo.** Backtesting en TradingView no garantiza resultados futuros. Prueba siempre en paper trading antes de operar con capital real.\n")

    lines.append("## 🚀 Cómo usar en TradingView\n")
    lines.append("1. Abre [TradingView](https://tradingview.com) y busca el ticker")
    lines.append("2. Haz clic en **Pine Editor** (parte inferior del chart)")
    lines.append("3. Borra el contenido actual y pega el código de abajo")
    lines.append("4. Haz clic en **Add to chart** (botón azul)")
    lines.append("5. Ve a la pestaña **Strategy Tester** para ver el backtesting")
    lines.append("6. Ajusta los parámetros en **Settings → Inputs** según tus preferencias")
    lines.append("7. Para paper trading: activa **Paper Trading** en la barra lateral derecha\n")

    inputs = extract_inputs(pine_code)
    if inputs:
        lines.append("## 🎛️ Parámetros configurables\n")
        for var, title in inputs[:10]:
            lines.append(f"- **{title}** (`{var}`)")
        lines.append("")

    lines.append("## 📝 Pine Script v5\n")
    lines.append("```pine")
    lines.append(pine_code)
    lines.append("```")

    lines.append("\n---")
    lines.append("_Generado por DiscontrolsBags Strategy Factory · Pipeline: Stock Analyzer → Strategy Designer → Strategy Critic → Strategy Optimizer → Reporter_")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
