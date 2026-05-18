"""
Agente: Wallet Analyzer (Polymarket)
Modo A — Mercado específico (condition_id):
  Busca los top holders de un mercado concreto y analiza
  en qué dirección están apostando los wallets más rentables.

Modo B — Descubrimiento global:
  Encuentra los wallets más rentables del leaderboard crypto
  y extrae sus posiciones abiertas como señales.

Input (JSON del Market Scanner):
{
  "candidates": [{
    "condition_id": "0x...",
    "question":     "...",
    "price_yes":    0.54
  }]
}
O bien directamente: { "condition_id": "0x..." }
O bien texto libre con una URL de Polymarket.

APIs:
  Holders:     https://data-api.polymarket.com/positions?market={condition_id}
  Leaderboard: https://data-api.polymarket.com/v1/leaderboard
  Positions:   https://data-api.polymarket.com/positions?user={wallet}
"""
import os
import sys
import json
import re
import time
import urllib.request
import urllib.error
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

DATA_API  = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

BROWSER_HEADERS = {
    "Accept":          "application/json",
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://polymarket.com",
    "Referer":         "https://polymarket.com/",
}

CRYPTO_KEYWORDS = [
    "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto",
    "xrp", "ripple", "bnb", "doge", "dogecoin", "coinbase", "binance",
    "defi", "token", "blockchain", "price", "halving", "nft", "web3",
]

TOP_HOLDERS   = int(os.environ.get("WALLET_ANALYZER_TOP_HOLDERS", "20"))
TOP_WHALES    = int(os.environ.get("WALLET_ANALYZER_TOP_WHALES", "20"))
MIN_PNL_USD   = float(os.environ.get("WALLET_ANALYZER_MIN_PNL", "500"))
MIN_SIZE_USDC = float(os.environ.get("WALLET_ANALYZER_MIN_SIZE", "10"))


# ── HTTP ──────────────────────────────────────────────────────────────────────

def http_get(url: str) -> dict | list:
    req = urllib.request.Request(url, headers=BROWSER_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


# ── Parsers ───────────────────────────────────────────────────────────────────

def extract_condition_id(raw: str) -> str:
    """Extrae condition_id del input (JSON del Market Scanner o texto libre)."""
    # Limpiar bloques markdown
    clean = re.sub(r'```[a-z]*\n?', '', raw).strip()

    # Buscar condition_id directamente
    m = re.search(r'"condition_id"\s*:\s*"(0x[a-fA-F0-9]+)"', clean)
    if m:
        return m.group(1)

    # Buscar en candidates[0]
    try:
        data = json.loads(clean)
        candidates = data.get("candidates", [])
        if candidates:
            cid = candidates[0].get("condition_id", "")
            if cid:
                return cid
        return data.get("condition_id", "")
    except Exception:
        pass

    # Buscar hex de 64 chars (condition_id format)
    m = re.search(r'0x[a-fA-F0-9]{60,66}', clean)
    return m.group(0) if m else ""


def extract_market_meta(raw: str) -> dict:
    """Extrae metadatos del mercado del input."""
    clean = re.sub(r'```[a-z]*\n?', '', raw).strip()
    try:
        data = json.loads(clean)
        candidates = data.get("candidates", [])
        if candidates:
            return candidates[0]
        return data
    except Exception:
        return {}


# ── Modo A: Top holders de un mercado específico ──────────────────────────────

def get_market_holders(condition_id: str, limit: int = 50) -> list:
    """Obtiene los holders de un mercado específico."""
    # Validar formato condition_id (debe ser 0x + 64 hex chars = 66 chars)
    if not condition_id or len(condition_id) < 60:
        print(f"  ⚠️  condition_id inválido o truncado: '{condition_id[:20]}...'", flush=True)
        return []

    # Intentar con parámetro 'market' primero, luego 'conditionId'
    for param in ["market", "conditionId", "condition_id"]:
        url = (
            f"{DATA_API}/positions"
            f"?{param}={condition_id}&limit={limit}"
            f"&sortBy=TOKENS&sortDirection=DESC"
        )
        print(f"  📡 Holders [{param}]: {url[:90]}...", flush=True)
        try:
            data = http_get(url)
            result = data if isinstance(data, list) else []
            if result:
                print(f"  ✅ {len(result)} holders encontrados con param '{param}'", flush=True)
                return result
        except urllib.error.HTTPError as e:
            print(f"  ⚠️  HTTP {e.code} con param '{param}'", flush=True)
            continue
        except Exception as e:
            print(f"  ⚠️  Error con param '{param}': {e}", flush=True)
            continue

    return []


def get_wallet_pnl(wallet: str) -> float:
    """Obtiene el P&L total de un wallet del leaderboard."""
    try:
        url  = f"{DATA_API}/v1/leaderboard?user={wallet}&timePeriod=ALL"
        data = http_get(url)
        rows = data if isinstance(data, list) else []
        if rows:
            return float(rows[0].get("pnl", 0) or 0)
    except Exception:
        pass
    return 0.0


def analyze_market_holders(condition_id: str, market_meta: dict) -> dict:
    """
    Analiza los holders de un mercado específico.
    Devuelve: top holders, dirección dominante, señal de consenso.
    """
    holders = get_market_holders(condition_id, limit=TOP_HOLDERS * 2)
    if not holders:
        return {"error": "No holders found"}

    # Enriquecer con P&L global del wallet (muestra quiénes son los buenos traders)
    enriched = []
    for i, h in enumerate(holders[:TOP_HOLDERS]):
        wallet = h.get("proxyWallet") or h.get("user", "")
        if not wallet:
            continue

        size     = float(h.get("currentValue") or h.get("size") or 0)
        avg_px   = float(h.get("avgPrice") or 0)
        cash_pnl = float(h.get("cashPnl") or 0)
        outcome  = (h.get("outcome") or h.get("side") or "").upper()

        # Determinar YES/NO por outcome o por avgPrice
        if not outcome:
            outcome = "YES" if avg_px <= 0.5 else "NO"

        if size < MIN_SIZE_USDC:
            continue

        # Obtener P&L global del wallet (throttled)
        global_pnl = 0.0
        if i < 10:  # Solo top 10 para evitar rate limit
            global_pnl = get_wallet_pnl(wallet)
            time.sleep(0.3)

        enriched.append({
            "wallet":     wallet,
            "short":      wallet[:8] + "…",
            "outcome":    outcome,
            "size_usdc":  round(size, 2),
            "avg_price":  round(avg_px, 4),
            "pnl_market": round(cash_pnl, 2),
            "global_pnl": round(global_pnl, 2),
            "is_whale":   global_pnl >= MIN_PNL_USD,
        })

    if not enriched:
        return {"error": "No significant holders"}

    # Calcular consenso
    yes_holders  = [h for h in enriched if h["outcome"] == "YES"]
    no_holders   = [h for h in enriched if h["outcome"] == "NO"]
    yes_volume   = sum(h["size_usdc"] for h in yes_holders)
    no_volume    = sum(h["size_usdc"] for h in no_holders)
    whale_yes    = [h for h in yes_holders if h["is_whale"]]
    whale_no     = [h for h in no_holders if h["is_whale"]]

    total_volume = yes_volume + no_volume
    yes_pct      = yes_volume / total_volume if total_volume else 0.5

    dominant_side  = "YES" if yes_pct >= 0.5 else "NO"
    signal_strength = abs(yes_pct - 0.5) * 2  # 0-1

    return {
        "condition_id":   condition_id,
        "question":       market_meta.get("question", ""),
        "price_yes":      market_meta.get("price_yes", 0),
        "holders":        enriched,
        "yes_holders":    len(yes_holders),
        "no_holders":     len(no_holders),
        "yes_volume":     round(yes_volume, 2),
        "no_volume":      round(no_volume, 2),
        "yes_pct":        round(yes_pct, 4),
        "whale_yes":      len(whale_yes),
        "whale_no":       len(whale_no),
        "dominant_side":  dominant_side,
        "signal_strength": round(signal_strength, 3),
        "consensus":      signal_strength >= 0.3,
    }


# ── Modo B: Leaderboard global ────────────────────────────────────────────────

def get_leaderboard(limit: int = 50) -> list:
    url  = f"{DATA_API}/v1/leaderboard?category=CRYPTO&timePeriod=ALL&orderBy=PNL&limit={limit}"
    data = http_get(url)
    return data if isinstance(data, list) else []


def get_positions(wallet: str) -> list:
    url  = f"{DATA_API}/positions?user={wallet}&limit=20&sortBy=CASHPNL&sortDirection=DESC"
    try:
        data = http_get(url)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def is_crypto_position(pos: dict) -> bool:
    title = (pos.get("title") or pos.get("question") or "").lower()
    return any(k in title for k in CRYPTO_KEYWORDS)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    issue_title, issue_body = resolve_issue_context()
    raw = f"{issue_title}\n{issue_body}".strip()

    # Detectar modo
    condition_id = extract_condition_id(raw)
    market_meta  = extract_market_meta(raw)

    if condition_id:
        # ── MODO A: Analizar holders de mercado específico ──────────────────
        post_issue_comment(
            f"🐋 **Wallet Analyzer — Modo: Mercado específico**\n\n"
            f"Buscando quién está apostando en este mercado...\n"
            f"`{condition_id[:20]}…`"
        )
        print(f"🎯 Modo A: condition_id = {condition_id[:20]}...", flush=True)

        result = analyze_market_holders(condition_id, market_meta)

        if "error" in result:
            post_issue_result(f"❌ {result['error']}")
            return

        # Formatear output
        question = result.get("question", "")
        price    = result.get("price_yes", 0)
        dom      = result["dominant_side"]
        strength = result["signal_strength"]
        yes_pct  = result["yes_pct"]

        strength_emoji = "🟢" if strength >= 0.5 else "🟡" if strength >= 0.3 else "🔴"
        dom_emoji      = "🟢" if dom == "YES" else "🔴"

        lines = ["# 🐋 WALLET ANALYZER — Holders del Mercado\n"]
        if question:
            lines.append(f"**{question}**\n")

        lines.append(f"| Métrica | Valor |")
        lines.append(f"|---|---|")
        lines.append(f"| Precio mercado YES | {price:.0%} |")
        lines.append(f"| Volumen YES holders | ${result['yes_volume']:,.0f} ({yes_pct:.0%}) |")
        lines.append(f"| Volumen NO holders | ${result['no_volume']:,.0f} ({1-yes_pct:.0%}) |")
        lines.append(f"| Holders YES / NO | {result['yes_holders']} / {result['no_holders']} |")
        lines.append(f"| Whales YES / NO | {result['whale_yes']} / {result['whale_no']} |")
        lines.append(f"| Dirección dominante | {dom_emoji} **{dom}** |")
        lines.append(f"| Fuerza señal | {strength_emoji} {strength:.0%} |")
        lines.append("")

        # Top holders
        lines.append("## Top Holders")
        lines.append("| Wallet | Lado | Tamaño | Precio entrada | P&L mercado | Whale |")
        lines.append("|---|---|---|---|---|---|")
        for h in result["holders"][:10]:
            side_e  = "🟢" if h["outcome"] == "YES" else "🔴"
            whale_e = "🐋" if h["is_whale"] else "—"
            lines.append(
                f"| `{h['short']}` | {side_e} {h['outcome']} "
                f"| ${h['size_usdc']:,.0f} "
                f"| {h['avg_price']:.0%} "
                f"| ${h['pnl_market']:+.0f} "
                f"| {whale_e} |"
            )
        lines.append("")

        # Señal
        if result["consensus"]:
            lines.append(
                f"## 🎯 SEÑAL\n"
                f"El **{yes_pct:.0%}** del volumen está en **{dom}**. "
                f"{'Los whales confirman la dirección.' if (result['whale_yes'] > result['whale_no']) == (dom == 'YES') else 'Ojo: los whales divergen de la mayoría.'}"
            )

        output_json = {
            **result,
            "holders": result["holders"][:10],
            "source":  "market_holders",
        }
        lines.append("\n```json")
        lines.append(json.dumps(output_json, indent=2, ensure_ascii=False)[:6000])
        lines.append("```")

        post_issue_result("\n".join(lines))

    else:
        # ── MODO B: Leaderboard global ──────────────────────────────────────
        post_issue_comment(
            "🐋 **Wallet Analyzer — Modo: Descubrimiento global**\n\n"
            "Buscando top traders crypto en el leaderboard..."
        )
        print("🌍 Modo B: leaderboard global", flush=True)

        leaderboard = get_leaderboard(limit=50)
        top_traders = [
            t for t in leaderboard
            if float(t.get("pnl", 0) or 0) >= MIN_PNL_USD
        ][:TOP_WHALES]

        analyzed = []
        for i, trader in enumerate(top_traders):
            wallet = trader.get("proxyWallet", "")
            if not wallet:
                continue
            positions  = get_positions(wallet)
            crypto_pos = [p for p in positions if is_crypto_position(p)]
            analyzed.append({
                "wallet":      wallet,
                "username":    trader.get("userName") or "anon",
                "pnl_usd":     round(float(trader.get("pnl", 0) or 0), 2),
                "volume_usd":  round(float(trader.get("vol", 0) or 0), 2),
                "crypto_positions": [
                    {
                        "title":     p.get("title", "")[:80],
                        "outcome":   p.get("outcome", "YES"),
                        "size_usdc": round(float(p.get("currentValue", 0) or 0), 2),
                        "avg_price": round(float(p.get("avgPrice", 0) or 0), 4),
                        "pnl_usdc":  round(float(p.get("cashPnl", 0) or 0), 2),
                    }
                    for p in crypto_pos[:5]
                ],
            })
            time.sleep(0.3)

        analyzed.sort(key=lambda x: x["pnl_usd"], reverse=True)

        lines = ["# 🐋 WALLET ANALYZER — Top Crypto Whales\n"]
        for i, w in enumerate(analyzed[:10], 1):
            lines.append(f"## #{i} {w['username']} — P&L ${w['pnl_usd']:,.0f}")
            for p in w["crypto_positions"]:
                e = "🟢" if p["outcome"] == "YES" else "🔴"
                lines.append(f"- {e} **{p['outcome']}** @ {p['avg_price']:.0%} — ${p['size_usdc']:.0f} — {p['title']}")
            lines.append("")

        output_json = {"top_whales": analyzed[:10], "source": "leaderboard_global"}
        lines.append("```json")
        lines.append(json.dumps(output_json, indent=2, ensure_ascii=False)[:6000])
        lines.append("```")

        post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
