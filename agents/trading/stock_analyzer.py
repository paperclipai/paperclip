"""
Agente: Stock Analyzer
Descarga datos OHLCV de Yahoo Finance y calcula métricas técnicas básicas.

Input (JSON del CEO):
  {"ticker": "AAPL", "style": "momentum"}

Output: JSON con precio, tendencia, volatilidad, ATR, SMAs y muestra OHLCV.
"""
import os
import sys
import json
import re
import math
import urllib.request
import urllib.error
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1y"
HEADERS     = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


# ── Data fetching ─────────────────────────────────────────────────────────────

def fetch_ohlcv(ticker: str) -> dict:
    url = YAHOO_CHART.format(ticker=ticker.upper())
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    result = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    q          = result["indicators"]["quote"][0]
    closes     = q["close"]
    highs      = q["high"]
    lows       = q["low"]
    volumes    = q["volume"]
    # Filtrar entradas None
    rows = [
        (t, c, h, l, v)
        for t, c, h, l, v in zip(timestamps, closes, highs, lows, volumes)
        if None not in (c, h, l, v)
    ]
    return rows  # lista de (timestamp, close, high, low, volume)


# ── Indicadores (Python puro) ─────────────────────────────────────────────────

def sma(values: list, period: int) -> float | None:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def atr(rows: list, period: int = 14) -> float | None:
    if len(rows) < period + 1:
        return None
    true_ranges = []
    for i in range(1, len(rows)):
        _, c_prev, _, _, _ = rows[i - 1]
        _, c,      h, l, _ = rows[i]
        tr = max(h - l, abs(h - c_prev), abs(l - c_prev))
        true_ranges.append(tr)
    return sum(true_ranges[-period:]) / period


def annualized_volatility(closes: list, period: int = 252) -> float | None:
    if len(closes) < 20:
        return None
    returns = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes))]
    n       = len(returns)
    mean    = sum(returns) / n
    variance = sum((r - mean) ** 2 for r in returns) / n
    return math.sqrt(variance) * math.sqrt(period)


def pct_change(closes: list, days: int) -> float | None:
    if len(closes) <= days:
        return None
    return (closes[-1] - closes[-days - 1]) / closes[-days - 1]


# ── Parser input ──────────────────────────────────────────────────────────────

def parse_input(raw: str) -> dict:
    ticker = "AAPL"
    style  = "momentum"
    try:
        data   = json.loads(raw.strip())
        ticker = data.get("ticker", ticker).upper()
        style  = data.get("style", style).lower()
        return {"ticker": ticker, "style": style}
    except Exception:
        pass
    # Fallback: extraer ticker con regex (1-5 letras mayúsculas)
    m = re.search(r'\b([A-Z]{1,5})\b', raw.upper())
    if m:
        ticker = m.group(1)
    for kw in ["momentum", "breakout", "mean_reversion", "reversal", "trend"]:
        if kw.replace("_", " ") in raw.lower() or kw in raw.lower():
            style = kw
            break
    return {"ticker": ticker, "style": style}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    os.environ["PAPERCLIP_COMPANY_ID"] = "866b74e7-79a7-4166-9f9f-025faa751aa1"
    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")

    params = parse_input(raw)
    ticker = params["ticker"]
    style  = params["style"]

    post_issue_comment(f"📈 Stock Analyzer — descargando datos de `{ticker}` desde Yahoo Finance...")
    print(f"📡 Fetching {ticker} OHLCV (1 año, intervalo diario)...", flush=True)

    try:
        rows = fetch_ohlcv(ticker)
    except Exception as e:
        post_issue_result(f"❌ Stock Analyzer: no se pudo obtener datos para `{ticker}`. Error: {e}")
        sys.exit(1)

    if len(rows) < 50:
        post_issue_result(f"❌ Stock Analyzer: datos insuficientes para `{ticker}` ({len(rows)} días).")
        sys.exit(1)

    closes  = [r[1] for r in rows]
    volumes = [r[4] for r in rows]

    current_price = closes[-1]
    s20           = sma(closes, 20)
    s50           = sma(closes, 50)
    s200          = sma(closes, 200)
    atr_14        = atr(rows, 14)
    vol_annual    = annualized_volatility(closes)
    chg_1d        = pct_change(closes, 1)
    chg_1m        = pct_change(closes, 21)
    chg_3m        = pct_change(closes, 63)
    avg_vol_20d   = sma(volumes, 20)

    # Tendencia
    if s50 and s200:
        if current_price > s50 > s200:
            trend = "strong_bullish"
        elif current_price > s50:
            trend = "bullish"
        elif current_price < s50 < s200:
            trend = "strong_bearish"
        elif current_price < s50:
            trend = "bearish"
        else:
            trend = "neutral"
    else:
        trend = "neutral"

    print(f"  ✅ {ticker}: ${current_price:.2f} | Trend: {trend} | ATR: {atr_14:.2f}", flush=True)

    # Muestra de los últimos 10 días
    ohlcv_sample = [
        {"close": round(r[1], 2), "high": round(r[2], 2),
         "low": round(r[3], 2), "volume": r[4]}
        for r in rows[-10:]
    ]

    output_json = {
        "ticker":          ticker,
        "style":           style,
        "current_price":   round(current_price, 2),
        "trend":           trend,
        "change_1d_pct":   round(chg_1d * 100, 2) if chg_1d is not None else None,
        "change_1m_pct":   round(chg_1m * 100, 2) if chg_1m is not None else None,
        "change_3m_pct":   round(chg_3m * 100, 2) if chg_3m is not None else None,
        "sma20":           round(s20, 2) if s20 else None,
        "sma50":           round(s50, 2) if s50 else None,
        "sma200":          round(s200, 2) if s200 else None,
        "atr_14":          round(atr_14, 2) if atr_14 else None,
        "volatility_annual_pct": round(vol_annual * 100, 1) if vol_annual else None,
        "avg_volume_20d":  int(avg_vol_20d) if avg_vol_20d else None,
        "days_of_data":    len(rows),
        "ohlcv_sample":    ohlcv_sample,
    }

    lines = [f"# 📈 STOCK ANALYZER — {ticker}\n"]
    lines.append(f"| Métrica | Valor |")
    lines.append(f"|---|---|")
    lines.append(f"| Precio actual | **${current_price:.2f}** |")
    lines.append(f"| Tendencia | {trend} |")
    lines.append(f"| Cambio 1D | {chg_1d*100:+.2f}% |" if chg_1d else "| Cambio 1D | N/A |")
    lines.append(f"| Cambio 1M | {chg_1m*100:+.2f}% |" if chg_1m else "| Cambio 1M | N/A |")
    lines.append(f"| Cambio 3M | {chg_3m*100:+.2f}% |" if chg_3m else "| Cambio 3M | N/A |")
    lines.append(f"| SMA 20 | ${s20:.2f} |" if s20 else "| SMA 20 | N/A |")
    lines.append(f"| SMA 50 | ${s50:.2f} |" if s50 else "| SMA 50 | N/A |")
    lines.append(f"| SMA 200 | ${s200:.2f} |" if s200 else "| SMA 200 | N/A |")
    lines.append(f"| ATR 14 | ${atr_14:.2f} |" if atr_14 else "| ATR 14 | N/A |")
    lines.append(f"| Volatilidad anual | {vol_annual*100:.1f}% |" if vol_annual else "| Volatilidad anual | N/A |")
    lines.append(f"| Volumen medio 20d | {int(avg_vol_20d):,} |" if avg_vol_20d else "| Volumen medio 20d | N/A |")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
