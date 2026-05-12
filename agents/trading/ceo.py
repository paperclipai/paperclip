"""
Agente: CEO Strategy Factory — DiscontrolsBags
Orquesta el pipeline completo de generación de estrategias de trading
algorítmico en Pine Script para TradingView.

Flujo:
1. Stock Analyzer      → datos OHLCV + métricas técnicas (Yahoo Finance)
2. Strategy Designer   → Pine Script generado por LLM
3. Strategy Critic     → revisión de lógica y calidad
4. Strategy Optimizer  → Pine Script refinado y corregido
5. Reporter            → output final con guía de uso en TradingView

Input (issue body):
  Texto libre con ticker y estilo, ej:
    "Crea estrategia momentum para AAPL"
    "TSLA breakout con volumen"
    {"ticker": "MSFT", "style": "mean_reversion"}
"""
import os
import sys
import json
import re
import hmac
import hashlib
import base64
import time
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# ── IDs de agentes en DiscontrolsBags ────────────────────────────────────────
# IMPORTANTE: ejecutar setup.py para obtener los UUIDs reales y reemplazar aquí.
AGENT_IDS = {
    "stock_analyzer":     "6f75364c-0ab2-48ac-9144-f40578435d67",  # ex Market Scanner
    "strategy_designer":  "ff3e3f5f-118f-451d-b042-91ec19d0cf11",  # ex Probability Estimator
    "strategy_critic":    "149be654-dccb-4da3-a6c6-091c5b5fe1e6",  # ex Risk Manager
    "strategy_optimizer": "61ced466-af5b-43be-a049-e94cf895274a",  # ex Executor
    "reporter":           "74bc12a4-6928-4450-b472-2962c3516627",  # Reporter (confirmado)
}

CEO_AGENT_ID    = "41df12d7-71c4-494e-a503-d02ef88fb1d8"  # ex CEO Polymarket
TRADING_COMPANY = "866b74e7-79a7-4166-9f9f-025faa751aa1"

STEP_WAIT = int(os.environ.get("TRADING_STEP_WAIT", "10"))


# ── JWT + API ─────────────────────────────────────────────────────────────────

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(secret: str) -> str:
    header  = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":"))
    now     = int(time.time())
    payload = json.dumps({
        "sub":          CEO_AGENT_ID,
        "company_id":   TRADING_COMPANY,
        "adapter_type": "process",
        "run_id":       os.environ["PAPERCLIP_RUN_ID"],
        "iat":          now,
        "exp":          now + 172800,
        "iss":          "paperclip",
        "aud":          "paperclip-api",
    }, separators=(",", ":"))
    si  = f"{b64url(header.encode())}.{b64url(payload.encode())}"
    sig = hmac.new(secret.encode(), si.encode(), hashlib.sha256).digest()
    return f"{si}.{b64url(sig)}"


def api(method: str, path: str, payload, headers: dict):
    api_url = os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100").rstrip("/")
    url     = f"{api_url}{path}"
    data    = json.dumps(payload).encode("utf-8") if payload is not None else None
    req     = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        print(f"  ⚠️  API {method} {path} → HTTP {e.code}: {body[:300]}", flush=True)
        return None
    except Exception as e:
        print(f"  ⚠️  API {method} {path} → {e}", flush=True)
        return None


def create_sub_issue(title: str, description: str, agent_key: str,
                     parent_id: str, headers: dict) -> str | None:
    agent_id = AGENT_IDS.get(agent_key, "")
    payload  = {
        "title":       title,
        "description": description[:20000],
        "status":      "todo",
        "parentId":    parent_id,
    }
    if agent_id and not agent_id.startswith("PLACEHOLDER"):
        payload["assigneeAgentId"] = agent_id

    result = api("POST", f"/api/companies/{TRADING_COMPANY}/issues", payload, headers)
    issue_id = (result or {}).get("id")
    if issue_id:
        print(f"  ✅ Sub-issue '{title}' → {issue_id}", flush=True)
    return issue_id


def get_issue_result(issue_id: str, headers: dict, max_wait: int = 180) -> str:
    deadline = time.time() + max_wait
    interval = 10
    time.sleep(interval)

    while time.time() < deadline:
        data   = api("GET", f"/api/issues/{issue_id}", None, headers)
        status = (data or {}).get("status", "")
        print(f"  ⏳ Issue {issue_id[:8]}… → {status}", flush=True)

        if status == "done":
            comments = api("GET", f"/api/issues/{issue_id}/comments?limit=10", None, headers)
            if isinstance(comments, list) and comments:
                # API devuelve comentarios en orden descendente (más nuevo primero)
                return comments[0].get("body", "")
            return ""

        if status in ("canceled", "failed"):
            return ""

        time.sleep(interval)

    print(f"  ⏰ Timeout esperando issue {issue_id}", flush=True)
    return ""


# ── Input parser ──────────────────────────────────────────────────────────────

STYLES = ["momentum", "breakout", "mean_reversion", "reversal", "trend_following", "scalping"]

def parse_input(raw: str) -> dict:
    """Extrae ticker y estilo del input del issue."""
    try:
        data = json.loads(raw.strip())
        return {
            "ticker": data.get("ticker", "AAPL").upper(),
            "style":  data.get("style", "momentum").lower(),
        }
    except Exception:
        pass

    ticker = "AAPL"
    style  = "momentum"

    m = re.search(r'\b([A-Z]{1,5})\b', raw.upper())
    if m:
        ticker = m.group(1)

    raw_lower = raw.lower()
    for s in STYLES:
        if s.replace("_", " ") in raw_lower or s in raw_lower:
            style = s
            break

    return {"ticker": ticker, "style": style}


# ── Helpers de extracción ─────────────────────────────────────────────────────

def extract_pine_script(text: str) -> str:
    """Extrae el bloque Pine Script de cualquier output."""
    if "```pine" in text:
        return text.split("```pine")[1].split("```")[0].strip()
    if "//@version" in text:
        for block in text.split("```")[1::2]:
            if "//@version" in block:
                return block.strip()
    return text.strip()


def compact_critic_for_optimizer(critic_result: str, pine_script: str) -> str:
    """
    Del output del Critic extrae el JSON de critique y lo compacta.
    Garantiza que el Pine Script original esté presente sin depender del límite de chars.
    """
    import re as _re
    data = {}
    if "```json" in critic_result:
        json_str = critic_result.split("```json")[1].split("```")[0].strip()
        try:
            data = json.loads(json_str)
        except Exception:
            pass
    if not data:
        m = _re.search(r'\{[\s\S]*?"overall_quality"[\s\S]*?\}', critic_result)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                pass
    data["original_script"] = pine_script
    return json.dumps(data, ensure_ascii=False)


# ── Pipeline ──────────────────────────────────────────────────────────────────

def run_pipeline(parent_issue_id: str, headers: dict, ticker: str, style: str) -> str:
    input_json = json.dumps({"ticker": ticker, "style": style})

    # ── PASO 1: Stock Analyzer ────────────────────────────────────────────────
    post_issue_comment(f"📈 **Paso 1/5** — Analizando `{ticker}` con Yahoo Finance...")
    analyzer_issue = create_sub_issue(
        f"Analyze {ticker}", input_json, "stock_analyzer", parent_issue_id, headers
    )
    if not analyzer_issue:
        return "❌ Falló al crear issue de Stock Analyzer"

    analyzer_result = get_issue_result(analyzer_issue, headers, max_wait=120)
    if not analyzer_result:
        return "❌ Stock Analyzer no devolvió resultado"

    # ── PASO 2: Strategy Designer ─────────────────────────────────────────────
    post_issue_comment(f"🎨 **Paso 2/5** — Diseñando estrategia `{style}` con LLM...")
    designer_issue = create_sub_issue(
        f"Design {style} strategy for {ticker}", analyzer_result,
        "strategy_designer", parent_issue_id, headers
    )
    if not designer_issue:
        return "❌ Falló al crear issue de Strategy Designer"

    designer_result = get_issue_result(designer_issue, headers, max_wait=180)
    if not designer_result:
        return "❌ Strategy Designer no devolvió resultado"

    # ── PASO 3: Strategy Critic ───────────────────────────────────────────────
    post_issue_comment("🔍 **Paso 3/5** — Revisando calidad del Pine Script...")
    critic_issue = create_sub_issue(
        f"Review strategy for {ticker}", designer_result,
        "strategy_critic", parent_issue_id, headers
    )
    if not critic_issue:
        return "❌ Falló al crear issue de Strategy Critic"

    critic_result = get_issue_result(critic_issue, headers, max_wait=120)
    if not critic_result:
        return "❌ Strategy Critic no devolvió resultado"

    # ── PASO 4: Strategy Optimizer ────────────────────────────────────────────
    post_issue_comment("⚙️ **Paso 4/5** — Optimizando y refinando la estrategia...")
    # Extraer Pine Script del Designer y construir input compacto para el Optimizer
    # (evita que el JSON del Critic quede truncado por límite de descripción)
    pine_from_designer = extract_pine_script(designer_result)
    optimizer_input    = compact_critic_for_optimizer(critic_result, pine_from_designer)
    optimizer_issue = create_sub_issue(
        f"Optimize strategy for {ticker}", optimizer_input,
        "strategy_optimizer", parent_issue_id, headers
    )
    if not optimizer_issue:
        return "❌ Falló al crear issue de Strategy Optimizer"

    optimizer_result = get_issue_result(optimizer_issue, headers, max_wait=180)
    if not optimizer_result:
        return "❌ Strategy Optimizer no devolvió resultado"

    # ── PASO 5: Reporter ──────────────────────────────────────────────────────
    post_issue_comment("📋 **Paso 5/5** — Generando reporte final...")
    # Pasar solo el Pine Script al Reporter (no el markdown completo del Optimizer)
    pine_final = extract_pine_script(optimizer_result)
    reporter_input = pine_final if len(pine_final) >= 50 else optimizer_result
    reporter_issue = create_sub_issue(
        f"Report strategy for {ticker}", reporter_input,
        "reporter", parent_issue_id, headers
    )
    if reporter_issue:
        get_issue_result(reporter_issue, headers, max_wait=60)

    return f"# ✅ CEO — Estrategia para `{ticker}` generada\n\nEstilo: `{style}` · Ver el issue del Reporter para el Pine Script final."


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("🤖 CEO Strategy Factory arrancando...", flush=True)
    # DiscontrolsBags — necesario para que resolve_issue_context() use el company correcto
    os.environ["PAPERCLIP_COMPANY_ID"] = "866b74e7-79a7-4166-9f9f-025faa751aa1"

    secret = os.environ.get("BETTER_AUTH_SECRET", "").strip()
    if not secret:
        print("ERROR: BETTER_AUTH_SECRET no configurado", file=sys.stderr)
        sys.exit(1)

    issue_id    = os.environ.get("PAPERCLIP_ISSUE_ID", "").strip()
    issue_title, issue_body = resolve_issue_context()
    print(f"   Input recibido: {len(issue_body)} chars body / {len(issue_title)} chars title", flush=True)
    raw = issue_body if issue_body else (issue_title or "AAPL momentum")

    params = parse_input(raw)
    ticker = params["ticker"]
    style  = params["style"]

    token   = make_jwt(secret)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
    }

    print(f"🤖 CEO STRATEGY FACTORY — DiscontrolsBags", flush=True)
    print(f"   Ticker: {ticker} | Estilo: {style}", flush=True)
    print(f"   Issue:  {issue_id}", flush=True)

    post_issue_comment(
        f"🤖 **CEO Strategy Factory** iniciando pipeline para `{ticker}`...\n\n"
        f"Estilo: `{style}` | Pipeline: Stock Analyzer → Strategy Designer → Strategy Critic → Optimizer → Reporter"
    )

    result = run_pipeline(issue_id, headers, ticker, style)
    post_issue_result(result)


if __name__ == "__main__":
    main()
