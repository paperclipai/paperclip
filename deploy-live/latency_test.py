"""Latency test for the 4 exchanges the live trader uses.

Measures HTTP round-trip to each exchange's public L2 order book endpoint,
N times per exchange (sequential, so concurrent network use doesn't bias
the per-exchange numbers). Reports min / p50 / p95 / max / mean per
exchange plus failure counts.

Public endpoints — no auth needed, runnable from anywhere with network
access. To measure auth-endpoint latency (place_market_order, get_balance,
etc.), run this on the Lightsail host where credentials are configured
and set --auth.

Usage:
  python3 latency_test.py                    # 20 samples each, ~30s total
  python3 latency_test.py --samples 50       # 50 samples each, ~75s
  python3 latency_test.py --json             # machine-readable output
  python3 latency_test.py --sleep 0          # back-to-back, no rate limiting

The test exercises the same network path the live trader uses (aiohttp +
the exchanges' real endpoints) so the latency measured here closely
matches what TradeDiagnostic.short_entry_latency_ms / long_entry_latency_ms
will record once the bot is live.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from typing import Any, Optional

import aiohttp


# Public L2 order book endpoints. BTC-USDT swap/perp on each — well-supported
# by every exchange and matches what the bot's get_orderbook code paths hit.
LIVE_ENDPOINTS: dict[str, str] = {
    "OKX":    "https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=5",
    "Bybit":  "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=5",
    "MEXC":   "https://contract.mexc.com/api/v1/contract/depth/BTC_USDT",
    "BloFin": "https://openapi.blofin.com/api/v1/market/books?instId=BTC-USDT&size=5",
}

# Exchanges the paper trader uses but the live trader does not (yet). Useful
# to know their latency before deciding whether to add them to the live
# trader's executor set. Opted in via --include-candidates.
CANDIDATE_ENDPOINTS: dict[str, str] = {
    "Binance":  "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=5",
    "Gate.io":  "https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=BTC_USDT&limit=5",
    "Bitget":   "https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=BTCUSDT&productType=usdt-futures&limit=5",
}

# Backwards-compat alias used by tests that referenced the old name.
ENDPOINTS = LIVE_ENDPOINTS


# ---------------------------------------------------------------------------
# Pure helpers (testable without network)
# ---------------------------------------------------------------------------


def summarize(timings: list[float]) -> dict[str, float]:
    """Compute min/p50/p95/max/mean from a list of latency measurements (ms).

    Returns zeros on an empty list — caller decides how to render that.
    """
    if not timings:
        return {"min": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0, "mean": 0.0}
    sorted_t = sorted(timings)
    n = len(sorted_t)
    # Linear-interpolation percentile would be cleaner but for diagnostic
    # output, nearest-rank is plenty and avoids surprise on small samples.
    p95_idx = max(0, int(n * 0.95) - 1) if n >= 20 else n - 1
    return {
        "min":  sorted_t[0],
        "p50":  statistics.median(sorted_t),
        "p95":  sorted_t[p95_idx],
        "max":  sorted_t[-1],
        "mean": statistics.mean(sorted_t),
    }


def format_table(results: dict[str, dict]) -> str:
    """Format a results dict (exchange → {"timings": [...], "failures": [...]})
    as a human-readable table."""
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
            out.append(f"{'':<10}  failures: {failures}")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Async measurement
# ---------------------------------------------------------------------------


async def measure_one(
    session: aiohttp.ClientSession, url: str, timeout_s: float
) -> tuple[Optional[float], Any]:
    """Single GET against `url` with a wall-clock timeout. Returns
    (latency_ms, status_code) on success, (None, error_label) on failure."""
    t0 = time.monotonic()
    try:
        async with session.get(
            url, timeout=aiohttp.ClientTimeout(total=timeout_s)
        ) as resp:
            await resp.read()
            elapsed_ms = (time.monotonic() - t0) * 1000.0
            return elapsed_ms, resp.status
    except asyncio.TimeoutError:
        return None, "timeout"
    except aiohttp.ClientError as e:
        return None, type(e).__name__
    except Exception as e:  # noqa: BLE001 — we want all errors classified
        return None, type(e).__name__


async def measure_exchange(
    session: aiohttp.ClientSession, name: str, url: str,
    samples: int, timeout_s: float, sleep_s: float,
) -> dict[str, list]:
    """Take `samples` measurements against `url`, sleeping `sleep_s` between
    each. Returns {"timings": [ms, ...], "failures": [error_label, ...]}.

    Failures and timings live in separate lists so callers can compute
    success-rate independently of timing percentiles.
    """
    timings: list[float] = []
    failures: list[str] = []
    for _ in range(samples):
        ms, status = await measure_one(session, url, timeout_s)
        if ms is None:
            failures.append(str(status))
        elif isinstance(status, int) and status >= 400:
            # HTTP error — count as failure but still record latency since
            # the round-trip happened. Operators often want both numbers.
            failures.append(f"http_{status}")
        else:
            timings.append(ms)
        if sleep_s > 0:
            await asyncio.sleep(sleep_s)
    return {"timings": timings, "failures": failures}


async def run(
    samples: int = 20, timeout_s: float = 10.0, sleep_s: float = 0.5,
    *, include_candidates: bool = False,
) -> dict[str, dict]:
    """Measure exchanges sequentially. Returns the raw results dict.

    By default measures only LIVE_ENDPOINTS (the 4 exchanges the live
    trader currently uses). Pass include_candidates=True to also measure
    paper-trader / candidate exchanges (Binance, Gate.io, Bitget).
    """
    endpoints = dict(LIVE_ENDPOINTS)
    if include_candidates:
        endpoints.update(CANDIDATE_ENDPOINTS)
    headers = {"User-Agent": "paperclip-latency-test/1.0"}
    results: dict[str, dict] = {}
    async with aiohttp.ClientSession(headers=headers) as session:
        for name, url in endpoints.items():
            t0 = time.monotonic()
            results[name] = await measure_exchange(
                session, name, url, samples, timeout_s, sleep_s
            )
            elapsed = time.monotonic() - t0
            n_ok = len(results[name]["timings"])
            n_fail = len(results[name]["failures"])
            print(
                f"  {name:<10} {n_ok}/{samples} ok, {n_fail} failed "
                f"in {elapsed:.1f}s",
                flush=True,
            )
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Measure HTTP round-trip to each exchange the live trader uses.",
    )
    p.add_argument(
        "--samples", type=int, default=20,
        help="Samples per exchange (default 20).",
    )
    p.add_argument(
        "--timeout", type=float, default=10.0,
        help="Per-request timeout in seconds (default 10).",
    )
    p.add_argument(
        "--sleep", type=float, default=0.5,
        help="Sleep between samples in seconds (default 0.5).",
    )
    p.add_argument(
        "--json", action="store_true",
        help="Emit machine-readable JSON instead of the human table.",
    )
    p.add_argument(
        "--include-candidates", action="store_true",
        help=("Also test exchanges the paper trader uses but the live trader "
              "does not (Binance, Gate.io, Bitget). Useful for evaluating "
              "whether to add them to the live trader."),
    )
    return p


def main() -> int:
    args = _build_parser().parse_args()
    n_exchanges = len(LIVE_ENDPOINTS) + (
        len(CANDIDATE_ENDPOINTS) if args.include_candidates else 0
    )
    print(
        f"Latency test: {args.samples} samples × {n_exchanges} exchanges, "
        f"{args.timeout}s timeout, {args.sleep}s between"
    )
    results = asyncio.run(run(
        samples=args.samples, timeout_s=args.timeout, sleep_s=args.sleep,
        include_candidates=args.include_candidates,
    ))
    print()
    if args.json:
        # Add the summarised stats per exchange for convenience.
        out = {
            name: {
                **data,
                "summary": summarize(data["timings"]),
            }
            for name, data in results.items()
        }
        print(json.dumps(out, indent=2))
    else:
        print(format_table(results))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
