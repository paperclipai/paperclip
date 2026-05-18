"""
Setup: Crea los agentes de trading algorítmico (TradingView) en DiscontrolsBags.
Ejecutar una sola vez desde Railway o localmente con las env vars correctas.

Uso:
  python agents/trading/setup.py

Variables requeridas:
  BETTER_AUTH_SECRET
  PAPERCLIP_AGENT_ID          (usa el director como actor temporal)
  PAPERCLIP_API_URL           (ej: http://localhost:3100 o la URL de Railway)
  PAPERCLIP_TRADING_COMPANY_ID=866b74e7-79a7-4166-9f9f-025faa751aa1
"""
import os
import sys
import json
import hmac
import hashlib
import base64
import time
import urllib.request
import urllib.error

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

TRADING_COMPANY_ID = os.environ.get(
    "PAPERCLIP_TRADING_COMPANY_ID",
    "866b74e7-79a7-4166-9f9f-025faa751aa1"
)

API_URL = os.environ.get(
    "PAPERCLIP_API_URL",
    "http://localhost:3100"
).rstrip("/")

# Agentes a crear en DiscontrolsBags
# (name, script_path, title, role, budget_cents)
TRADING_AGENTS = [
    (
        "CEO Strategy Factory",
        "agents/trading/ceo.py",
        "Trading Strategy Orchestrator — TradingView",
        "ceo",
        10000,
    ),
    (
        "Stock Analyzer",
        "agents/trading/stock_analyzer.py",
        "Yahoo Finance OHLCV + Technical Metrics",
        "engineer",
        2000,
    ),
    (
        "Strategy Designer",
        "agents/trading/strategy_designer.py",
        "LLM Pine Script Strategy Generator",
        "engineer",
        8000,
    ),
    (
        "Strategy Critic",
        "agents/trading/strategy_critic.py",
        "Pine Script Logic Reviewer",
        "engineer",
        4000,
    ),
    (
        "Strategy Optimizer",
        "agents/trading/strategy_optimizer.py",
        "LLM Pine Script Refiner",
        "engineer",
        8000,
    ),
    (
        "Reporter",
        "agents/trading/reporter.py",
        "Strategy Report & TradingView Export",
        "engineer",
        2000,
    ),
]


# ── JWT ──────────────────────────────────────────────────────────────────────

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(agent_id: str, company_id: str, secret: str) -> str:
    header  = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":"))
    now     = int(time.time())
    payload = json.dumps({
        "sub":          agent_id,
        "company_id":   company_id,
        "adapter_type": "process",
        "run_id":       "trading-setup",
        "iat":          now,
        "exp":          now + 172800,
        "iss":          "paperclip",
        "aud":          "paperclip-api",
    }, separators=(",", ":"))
    signing_input = f"{b64url(header.encode())}.{b64url(payload.encode())}"
    sig = hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


# ── HTTP ─────────────────────────────────────────────────────────────────────

def api(method: str, path: str, payload, headers: dict):
    url  = f"{API_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req  = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        print(f"  ⚠️  HTTP {e.code} → {body[:400]}", flush=True)
        return None
    except Exception as e:
        print(f"  ⚠️  {e}", flush=True)
        return None


# ── Core ─────────────────────────────────────────────────────────────────────

def ensure_agent(name: str, script: str, title: str, role: str,
                 budget: int, headers: dict, ceo_id: str = "") -> str:
    """Busca agente por nombre, lo crea si no existe. Devuelve su UUID."""
    # Listar existentes
    data = api("GET", f"/api/companies/{TRADING_COMPANY_ID}/agents", None, headers)
    agents = data if isinstance(data, list) else (data or {}).get("agents", [])

    for ag in agents:
        if isinstance(ag, dict) and ag.get("name", "").lower() == name.lower():
            found_id = ag.get("id", "")
            print(f"  ✅ Ya existe: '{name}' → {found_id}", flush=True)
            return found_id

    # Crear
    payload = {
        "name":               name,
        "title":              title,
        "role":               role,
        "adapterType":        "process",
        "adapterConfig":      {
            "command": "python",
            "args":    [script],
            "cwd":     "/app",
        },
        "budgetMonthlyCents": budget,
    }
    if ceo_id:
        payload["reportsTo"] = ceo_id

    result = api("POST", f"/api/companies/{TRADING_COMPANY_ID}/agents", payload, headers)
    new_id = (result or {}).get("id", "")
    if new_id:
        print(f"  ✅ Creado: '{name}' → {new_id}", flush=True)
    else:
        print(f"  ❌ Falló crear '{name}'", flush=True)
    return new_id


def main():
    secret   = os.environ.get("BETTER_AUTH_SECRET", "").strip()
    agent_id = os.environ.get("PAPERCLIP_AGENT_ID", "").strip()

    if not secret:
        print("ERROR: BETTER_AUTH_SECRET no configurado", file=sys.stderr)
        sys.exit(1)
    if not agent_id:
        print("ERROR: PAPERCLIP_AGENT_ID no configurado", file=sys.stderr)
        sys.exit(1)

    print(f"🤖 SETUP TRADING AGENTS (TradingView) — DiscontrolsBags", flush=True)
    print(f"   Company:  {TRADING_COMPANY_ID}", flush=True)
    print(f"   API URL:  {API_URL}", flush=True)
    print(f"   Actor:    {agent_id}", flush=True)
    print(flush=True)

    token   = make_jwt(agent_id, TRADING_COMPANY_ID, secret)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
    }

    # Verificar health
    try:
        req = urllib.request.Request(f"{API_URL}/api/health", headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            health = r.read().decode("utf-8")
        print(f"✅ API reachable: {health[:80]}", flush=True)
    except Exception as e:
        print(f"❌ API no alcanzable: {e}", file=sys.stderr)
        sys.exit(1)

    created = {}

    # Crear CEO primero
    print("\n📋 Creando agentes...", flush=True)
    name, script, title, role, budget = TRADING_AGENTS[0]
    ceo_id = ensure_agent(name, script, title, role, budget, headers)
    created["CEO"] = ceo_id

    # Crear el resto reportando al CEO
    for name, script, title, role, budget in TRADING_AGENTS[1:]:
        aid = ensure_agent(name, script, title, role, budget, headers, ceo_id=ceo_id)
        created[name] = aid

    # Resumen
    print("\n" + "="*50, flush=True)
    print("📊 AGENTES CREADOS EN DiscontrolsBags:\n", flush=True)
    for name, aid in created.items():
        status = "✅" if aid else "❌"
        print(f"  {status} {name}: {aid}", flush=True)

    print("\n💡 Añade estas variables en Railway:", flush=True)
    for name, aid in created.items():
        if aid:
            key = name.upper().replace(" ", "_") + "_AGENT_ID"
            print(f"   {key}={aid}", flush=True)

    print("\n✅ Setup completo.", flush=True)


if __name__ == "__main__":
    main()
