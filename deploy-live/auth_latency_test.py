"""Authenticated-endpoint latency test for all 7 exchanges.

Public-endpoint latency (latency_test.py) doesn't tell the full story
because real trades require:
  - HMAC signing on the client side (a few ms)
  - Auth pipeline on the exchange side (10-40ms)
  - Risk checks + return path

This script makes one authenticated, read-only GET per exchange
(equivalent of `get_balance` / `get_account_info`) and measures end-to-end
round-trip. Closer to what `place_market_order` actually takes.

NEVER places orders. NEVER cancels orders. Only reads account state.

Usage on Lightsail:
  python3 auth_latency_test.py                    # current 4 live exchanges
  python3 auth_latency_test.py --include-candidates  # also Binance/Gate.io/Bitget

Per-exchange env vars:
  OKX_API_KEY,    OKX_API_SECRET,    OKX_PASSPHRASE
  BYBIT_API_KEY,  BYBIT_API_SECRET
  MEXC_API_KEY,   MEXC_API_SECRET
  BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_PASSPHRASE
  BINANCE_API_KEY, BINANCE_API_SECRET
  GATEIO_API_KEY,  GATEIO_API_SECRET
  BITGET_API_KEY,  BITGET_API_SECRET, BITGET_PASSPHRASE

Exchanges with missing keys are skipped cleanly with a clear message.
HTTP 4xx (auth failure) is reported as "auth_failed" rather than counted
as a normal latency sample.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import statistics
import time
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlencode

import aiohttp


# ---------------------------------------------------------------------------
# Signed-request builders. Each returns (method, url, headers, body) for a
# read-only "get account info / balance" endpoint, or None if API keys
# for that exchange aren't configured.
#
# Signing schemes follow each exchange's official docs. For the 4 live
# exchanges these mirror the patterns in real_trader.py's executors.
# ---------------------------------------------------------------------------


def _has(*names: str) -> bool:
    return all(os.environ.get(n, "").strip() for n in names)


def build_okx() -> Optional[tuple[str, str, dict, str]]:
    if not _has("OKX_API_KEY", "OKX_API_SECRET", "OKX_PASSPHRASE"):
        return None
    api_key    = os.environ["OKX_API_KEY"]
    api_secret = os.environ["OKX_API_SECRET"]
    passphrase = os.environ["OKX_PASSPHRASE"]
    method     = "GET"
    path       = "/api/v5/account/balance?ccy=USDT"
    body       = ""
    now        = datetime.now(timezone.utc)
    ts         = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    msg        = ts + method + path + body
    sig        = base64.b64encode(hmac.new(api_secret.encode(), msg.encode(), hashlib.sha256).digest()).decode()
    headers    = {
        "OK-ACCESS-KEY":        api_key,
        "OK-ACCESS-SIGN":       sig,
        "OK-ACCESS-TIMESTAMP":  ts,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "Content-Type":         "application/json",
    }
    return method, "https://www.okx.com" + path, headers, body


def build_bybit() -> Optional[tuple[str, str, dict, str]]:
    if not _has("BYBIT_API_KEY", "BYBIT_API_SECRET"):
        return None
    api_key    = os.environ["BYBIT_API_KEY"]
    api_secret = os.environ["BYBIT_API_SECRET"]
    method     = "GET"
    path       = "/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT"
    ts         = str(int(time.time() * 1000))
    recv       = "5000"
    # Bybit V5: signature = HMAC(secret, timestamp + api_key + recv_window + queryString)
    qs         = "accountType=UNIFIED&coin=USDT"
    msg        = ts + api_key + recv + qs
    sig        = hmac.new(api_secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    headers    = {
        "X-BAPI-API-KEY":     api_key,
        "X-BAPI-SIGN":        sig,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": recv,
        "Content-Type":       "application/json",
    }
    return method, "https://api.bybit.com" + path, headers, ""


def build_mexc() -> Optional[tuple[str, str, dict, str]]:
    if not _has("MEXC_API_KEY", "MEXC_API_SECRET"):
        return None
    api_key    = os.environ["MEXC_API_KEY"]
    api_secret = os.environ["MEXC_API_SECRET"]
    method     = "GET"
    # MEXC futures: GET /api/v1/private/account/assets — signature is
    # HMAC-SHA256 of sorted-params query string with ApiKey + ReqTime as headers.
    ts         = str(int(time.time() * 1000))
    params     = {}  # no params for this endpoint
    sorted_q   = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    sign_str   = api_key + ts + sorted_q
    sig        = hmac.new(api_secret.encode(), sign_str.encode(), hashlib.sha256).hexdigest()
    headers    = {
        "ApiKey":       api_key,
        "Request-Time": ts,
        "Signature":    sig,
        "Content-Type": "application/json",
    }
    path = "/api/v1/private/account/assets"
    return method, "https://contract.mexc.com" + path, headers, ""


def build_blofin() -> Optional[tuple[str, str, dict, str]]:
    if not _has("BLOFIN_API_KEY", "BLOFIN_API_SECRET", "BLOFIN_PASSPHRASE"):
        return None
    api_key    = os.environ["BLOFIN_API_KEY"]
    api_secret = os.environ["BLOFIN_API_SECRET"]
    passphrase = os.environ["BLOFIN_PASSPHRASE"]
    method     = "GET"
    path       = "/api/v1/asset/balances?accountType=futures"
    body       = ""
    now        = datetime.now(timezone.utc)
    ts         = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    msg        = ts + method + path + body
    sig        = base64.b64encode(hmac.new(api_secret.encode(), msg.encode(), hashlib.sha256).digest()).decode()
    headers    = {
        "ACCESS-KEY":        api_key,
        "ACCESS-SIGN":       sig,
        "ACCESS-TIMESTAMP":  ts,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type":      "application/json",
    }
    return method, "https://openapi.blofin.com" + path, headers, body


def build_binance() -> Optional[tuple[str, str, dict, str]]:
    if not _has("BINANCE_API_KEY", "BINANCE_API_SECRET"):
        return None
    api_key    = os.environ["BINANCE_API_KEY"]
    api_secret = os.environ["BINANCE_API_SECRET"]
    method     = "GET"
    path       = "/fapi/v2/account"
    ts         = int(time.time() * 1000)
    params     = {"timestamp": ts, "recvWindow": 5000}
    qs         = urlencode(params)
    sig        = hmac.new(api_secret.encode(), qs.encode(), hashlib.sha256).hexdigest()
    full_url   = f"https://fapi.binance.com{path}?{qs}&signature={sig}"
    headers    = {"X-MBX-APIKEY": api_key}
    return method, full_url, headers, ""


def build_gateio() -> Optional[tuple[str, str, dict, str]]:
    if not _has("GATEIO_API_KEY", "GATEIO_API_SECRET"):
        return None
    api_key    = os.environ["GATEIO_API_KEY"]
    api_secret = os.environ["GATEIO_API_SECRET"]
    method     = "GET"
    url_path   = "/api/v4/futures/usdt/accounts"
    query      = ""
    body       = ""
    body_hash  = hashlib.sha512(body.encode()).hexdigest()
    ts         = str(time.time())
    # Gate.io v4 futures: SIGN = HMAC-SHA512(secret, METHOD\nPATH\nQUERY\nHASHED_PAYLOAD\nTIMESTAMP)
    sign_str   = f"{method}\n{url_path}\n{query}\n{body_hash}\n{ts}"
    sig        = hmac.new(api_secret.encode(), sign_str.encode(), hashlib.sha512).hexdigest()
    headers    = {
        "KEY":          api_key,
        "Timestamp":    ts,
        "SIGN":         sig,
        "Content-Type": "application/json",
    }
    return method, "https://api.gateio.ws" + url_path, headers, body


def build_bitget() -> Optional[tuple[str, str, dict, str]]:
    if not _has("BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_PASSPHRASE"):
        return None
    api_key    = os.environ["BITGET_API_KEY"]
    api_secret = os.environ["BITGET_API_SECRET"]
    passphrase = os.environ["BITGET_PASSPHRASE"]
    method     = "GET"
    # Bitget v2 mix: GET /api/v2/mix/account/accounts?productType=USDT-FUTURES
    url_path   = "/api/v2/mix/account/accounts"
    query      = "?productType=USDT-FUTURES"
    body       = ""
    ts         = str(int(time.time() * 1000))
    prehash    = ts + method + url_path + query + body
    sig        = base64.b64encode(hmac.new(api_secret.encode(), prehash.encode(), hashlib.sha256).digest()).decode()
    headers    = {
        "ACCESS-KEY":        api_key,
        "ACCESS-SIGN":       sig,
        "ACCESS-TIMESTAMP":  ts,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type":      "application/json",
        "locale":            "en-US",
    }
    return method, "https://api.bitget.com" + url_path + query, headers, body


LIVE_BUILDERS = {
    "OKX":    build_okx,
    "Bybit":  build_bybit,
    "MEXC":   build_mexc,
    "BloFin": build_blofin,
}

CANDIDATE_BUILDERS = {
    "Binance":  build_binance,
    "Gate.io":  build_gateio,
    "Bitget":   build_bitget,
}


# ---------------------------------------------------------------------------
# Stats helpers (re-using shape from latency_test.py)
# ---------------------------------------------------------------------------


def summarize(timings: list[float]) -> dict[str, float]:
    if not timings:
        return {"min": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0, "mean": 0.0}
    sorted_t = sorted(timings)
    n = len(sorted_t)
    p95_idx = max(0, int(n * 0.95) - 1) if n >= 20 else n - 1
    return {
        "min":  sorted_t[0],
        "p50":  statistics.median(sorted_t),
        "p95":  sorted_t[p95_idx],
        "max":  sorted_t[-1],
        "mean": statistics.mean(sorted_t),
    }


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------


async def measure_one(
    session: aiohttp.ClientSession,
    method: str, url: str, headers: dict, body: str,
    timeout_s: float,
) -> tuple[Optional[float], Any]:
    """One signed request. Returns (latency_ms, status). Status is HTTP code
    on a real response, or a string label on transport failure."""
    t0 = time.monotonic()
    try:
        async with session.request(
            method, url, headers=headers,
            data=body if body else None,
            timeout=aiohttp.ClientTimeout(total=timeout_s),
        ) as resp:
            await resp.read()
            elapsed_ms = (time.monotonic() - t0) * 1000.0
            return elapsed_ms, resp.status
    except asyncio.TimeoutError:
        return None, "timeout"
    except aiohttp.ClientError as e:
        return None, type(e).__name__
    except Exception as e:  # noqa: BLE001
        return None, type(e).__name__


async def measure_exchange(
    session: aiohttp.ClientSession, name: str, builder,
    samples: int, timeout_s: float, sleep_s: float,
) -> dict[str, list]:
    """Take `samples` signed measurements. Builder is called fresh each
    sample so timestamps and signatures don't go stale."""
    timings: list[float] = []
    failures: list[str] = []
    for _ in range(samples):
        req = builder()
        if req is None:
            # Should have been caught earlier; defensive.
            failures.append("no_credentials")
            break
        method, url, headers, body = req
        ms, status = await measure_one(session, method, url, headers, body, timeout_s)
        if ms is None:
            failures.append(str(status))
        elif isinstance(status, int) and 400 <= status < 500:
            # Auth-class failure — record but don't pollute the latency sample
            failures.append(f"auth_{status}")
        elif isinstance(status, int) and status >= 500:
            failures.append(f"http_{status}")
        else:
            timings.append(ms)
        if sleep_s > 0:
            await asyncio.sleep(sleep_s)
    return {"timings": timings, "failures": failures}


def format_table(results: dict[str, dict], skipped: list[str]) -> str:
    out = []
    out.append(
        f"{'Exchange':<10}  {'Samples':>7}  {'OK%':>5}  "
        f"{'min':>7}  {'p50':>7}  {'p95':>7}  {'max':>7}  {'mean':>7}"
    )
    out.append("-" * 76)
    for name, data in results.items():
        timings = data["timings"]
        failures = data["failures"]
        total = len(timings) + len(failures)
        if total == 0:
            out.append(f"{name:<10}  {'0':>7}  no samples")
            continue
        ok_pct = 100.0 * len(timings) / total
        if not timings:
            sample_failures = ", ".join(failures[:3])
            out.append(
                f"{name:<10}  {total:>7}  {'0%':>5}  all failed ({sample_failures})"
            )
            continue
        s = summarize(timings)
        out.append(
            f"{name:<10}  {total:>7}  {ok_pct:>4.0f}%  "
            f"{s['min']:>5.0f}ms  {s['p50']:>5.0f}ms  "
            f"{s['p95']:>5.0f}ms  {s['max']:>5.0f}ms  {s['mean']:>5.0f}ms"
        )
        if failures:
            # Show distinct failure labels with counts
            counts: dict[str, int] = {}
            for f in failures:
                counts[f] = counts.get(f, 0) + 1
            label = ", ".join(f"{f}×{n}" for f, n in counts.items())
            out.append(f"{'':<10}  failures: {label}")
    if skipped:
        out.append("")
        out.append(f"Skipped (no API keys configured): {', '.join(skipped)}")
    return "\n".join(out)


async def run(
    samples: int = 20, timeout_s: float = 10.0, sleep_s: float = 0.5,
    *, include_candidates: bool = False,
) -> tuple[dict[str, dict], list[str]]:
    builders = dict(LIVE_BUILDERS)
    if include_candidates:
        builders.update(CANDIDATE_BUILDERS)

    # Pre-flight: filter out exchanges with missing credentials so we don't
    # try to sign with empty strings.
    available: dict[str, callable] = {}
    skipped: list[str] = []
    for name, b in builders.items():
        if b() is None:
            skipped.append(name)
        else:
            available[name] = b

    results: dict[str, dict] = {}
    if not available:
        return results, skipped

    headers = {"User-Agent": "paperclip-auth-latency-test/1.0"}
    async with aiohttp.ClientSession(headers=headers) as session:
        for name, builder in available.items():
            t0 = time.monotonic()
            results[name] = await measure_exchange(
                session, name, builder, samples, timeout_s, sleep_s
            )
            elapsed = time.monotonic() - t0
            n_ok = len(results[name]["timings"])
            n_fail = len(results[name]["failures"])
            print(
                f"  {name:<10} {n_ok}/{samples} ok, {n_fail} failed "
                f"in {elapsed:.1f}s",
                flush=True,
            )
    return results, skipped


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Measure authenticated round-trip to each exchange "
                    "(read-only get-balance call). Never places orders.",
    )
    p.add_argument("--samples",  type=int,   default=20, help="Samples per exchange.")
    p.add_argument("--timeout",  type=float, default=10.0, help="Per-request timeout (s).")
    p.add_argument("--sleep",    type=float, default=0.5, help="Sleep between samples (s).")
    p.add_argument("--json",     action="store_true", help="Emit JSON instead of table.")
    p.add_argument("--include-candidates", action="store_true",
                   help="Also test Binance, Gate.io, Bitget.")
    return p


def main() -> int:
    args = _build_parser().parse_args()
    n_total = len(LIVE_BUILDERS) + (
        len(CANDIDATE_BUILDERS) if args.include_candidates else 0
    )
    print(
        f"Auth latency test: {args.samples} samples × up to {n_total} exchanges, "
        f"{args.timeout}s timeout, {args.sleep}s between"
    )
    results, skipped = asyncio.run(run(
        samples=args.samples, timeout_s=args.timeout, sleep_s=args.sleep,
        include_candidates=args.include_candidates,
    ))
    print()
    if args.json:
        out = {
            "results": {
                name: {**data, "summary": summarize(data["timings"])}
                for name, data in results.items()
            },
            "skipped": skipped,
        }
        print(json.dumps(out, indent=2))
    else:
        print(format_table(results, skipped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
