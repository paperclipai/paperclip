# Plan 3 progress + handoff

## Done in this session (Tasks 1–6, 8, 12, 13, 15, 16)

10 of 16 code tasks landed; 134 tests green.

| Task | Commit | What |
|---|---|---|
| 1 | `7534dce9` | MEXC normalizer fails loud on missing cummulativeQuoteQty (8a) |
| 2 | `2801ff52` | `upsert_recon_event` dedupes unresolved events; `repeat_count` + `last_seen_ms` columns added with idempotent in-place migration; replay fixture updated (8b) |
| 3 | `fd821b40` | Stale-OK exchange-health invariant gated on sweep loop running (8c) |
| 4 | `d5b51014` | `unchecked_exchange` info event makes outage-masked diff gaps visible (8d) |
| 12, 13, 15, 16 | `5d4d3e06` | Bundled: requirements (httpx, pytest-asyncio, pydantic), start.sh pre-start guard, CI workflow, size_mismatch golden fixture |
| 6 | `a2da54c9` | `LiveExchangeFetcher` adapter; sync API bridges into trader's async loop via `run_coroutine_threadsafe`; per-exchange position normalizers for OKX/Bybit/MEXC/BloFin |
| 8 | `f33add99` | `ShadowWriter` mirrors writes to SQLite under `SHADOW_SQLITE=true` with strict failure isolation |

## Remaining (Tasks 7, 9, 10, 11, 14 + ops Tasks 17–22)

All remaining tasks modify `real_trader.py` (3,413 lines, real-money production code) or `dashboard.py`, OR are manual operational steps on the Lightsail host (deploy, watch, migrate, cutover, decommission).

These were intentionally deferred:

1. **Live trader code is high-risk to modify in a single session.** Each touchpoint must be added carefully (initialization at startup, integration in `open_position`/`close_position`/each `ExchangeExecutor.place_market_order`), gated behind feature flags, and verified with the bot running in DRY_RUN mode before any deploy.
2. **Operational tasks need access to the Lightsail host** (SSH, tmux, `migrate_to_sqlite.py` execution against live data, watch-window monitoring).
3. **Plan 3's Definition of Done** requires the 72h watch windows, which are fundamentally calendar time, not code time.

## Concrete next-session entry points

### Task 7 — Normalizer wiring inside each `ExchangeExecutor.place_market_order`

Five sites in `real_trader.py`:

- OKX: line ~421 (`OKXExecutor.place_market_order`)
- Bybit: line ~592 (`BybitExecutor.place_market_order`)
- MEXC: line ~763 (`MEXCExecutor.place_market_order`)
- BloFin: line ~947 (`BloFinExecutor.place_market_order`)
- DryRun: line ~1110 (`DryRunExecutor.place_market_order`)

Pattern (apply to each):

```python
# After existing parsing of the raw response, before constructing OrderResult:
try:
    normalized = normalize_<ex>_order(raw, requested_size_usd=size_usd)
except ValidationError as e:
    log.error(f"{self.name} unparseable response: {e}")
    # Best-effort recon event (state_conn must be plumbed onto the executor or trader)
    normalized = None

result = OrderResult(...)
result.normalized = normalized  # new optional attribute
return result
```

Add `normalized: Optional[ExchangeOrderResponse] = None` to the `OrderResult` dataclass (line ~estimated near the data classes block).

### Task 9 — `state_store` + `AlertDispatcher` startup

In `LiveTrader.__init__` (line ~2375):

```python
from state_store import open_db, init_schema
from alerts import AlertDispatcher, ConsoleSink, TelegramSink, DigestSink
from shadow_writer import ShadowWriter
from live_exchange_fetcher import LiveExchangeFetcher

self.state_db_path = str(DATA_DIR / "state.db")
init_schema(self.state_db_path)
self.state_conn = open_db(self.state_db_path)

self.shadow = ShadowWriter(
    enabled=os.environ.get("SHADOW_SQLITE", "false").lower() == "true",
    db_path=self.state_db_path,
)

self.alerts = AlertDispatcher(dedup_window_s=60.0)
self.alerts.add_sink(ConsoleSink(), min_severity="info")
if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
    self.alerts.add_sink(
        TelegramSink(bot_token=TELEGRAM_BOT_TOKEN, chat_id=TELEGRAM_CHAT_ID),
        min_severity="warn",  # info silenced; digest handles batched warns
    )
```

Add a `DigestSink` if Plan 2's `alerts.py` doesn't have one (Plan 3 task 9.3 says to add it).

### Task 10 — Reconciler triggers

In trader's `__aenter__` or startup coroutine (after `LiveExchangeFetcher` is constructed, after the asyncio loop is running):

```python
loop = asyncio.get_running_loop()
self.fetcher = LiveExchangeFetcher(self.executors, loop=loop)

# Spawn the periodic sweep
if os.environ.get("SHADOW_SQLITE") == "true" or os.environ.get("USE_SQLITE_STATE") == "true":
    self.sweep_task = start_periodic_sweep(
        self.state_conn, self.fetcher,
        exchanges=EXCHANGES, interval_s=RECONCILE_INTERVAL_SEC,
    )
```

In `open_position` (line ~2123) and `close_position` (line ~2218), after each leg's order placement returns, call `schedule_per_trade_reconcile(self.state_conn, self.fetcher, exchange=ex, symbol=sym)`. Since the reconciler's sync API needs to be off-loop, wrap the call in `loop.run_in_executor`:

```python
loop.run_in_executor(None, lambda: schedule_per_trade_reconcile(
    self.state_conn, self.fetcher, exchange=ex, symbol=sym,
))
```

(or refactor `schedule_per_trade_reconcile` to be async and just `await` it; that's cleaner.)

### Task 11 — Invariants end-of-cycle

In the main poll loop (find the `while True:` in `LiveTrader.run` or equivalent), at end-of-cycle:

```python
if self._sqlite_active():
    violations = invariants.check_all(self.state_conn)
    violations += invariants.check_inmem_consistency(
        self.state_conn,
        in_memory_open_count=len(self.portfolio.open_positions()),
    )
    for v in violations:
        if self.invariant_rate_limiter.allow(v):
            from state_store import upsert_recon_event
            eid, _ = upsert_recon_event(
                self.state_conn,
                timestamp_ms=int(time.time() * 1000),
                source="invariants",
                category=v.category, severity=v.severity,
                exchange=v.exchange, symbol=v.symbol, position_id=v.position_id,
                expected=v.expected or None, actual=v.actual or None,
                notes=v.notes or None,
            )
            # Build a ReconciliationEvent for the dispatcher.
            from schemas import ReconciliationEvent
            await self.alerts.dispatch(ReconciliationEvent(
                timestamp_ms=int(time.time() * 1000),
                source="invariants",
                category=v.category, severity=v.severity,
                exchange=v.exchange, symbol=v.symbol, position_id=v.position_id,
                expected=v.expected or None, actual=v.actual or None,
                notes=v.notes or None,
            ))
```

Initialize the rate limiter once: `self.invariant_rate_limiter = invariants.RateLimiter(window_s=60.0)`.

### Task 14 — Dashboard recon panel

`dashboard.py` is 552 lines. Two changes:
1. Add a `_data_source()` selector at the top that branches on `USE_SQLITE_STATE`.
2. Add a Flask blueprint (`dashboard_recon.py`) with two routes:
   - `/recon/events` — paginated list from `list_unresolved_recon_events(...)` with severity filter.
   - `/recon/invariants` — runs `invariants.check_all(...)` against a fresh read connection and renders 12 rows green/red.

Mount the blueprint and add a nav link in the existing main template.

### Tasks 17–22 — Operations

Cannot be executed from this environment. The plan documents the sequence:
- **17**: Deploy in `SHADOW_SQLITE=true` mode; verify alerts initialize, no false-positive critical events.
- **18**: 24–72h watch window; daily counts query.
- **19**: Migration dry-run; review quarantine.
- **20**: Coordinated 5-minute downtime cutover.
- **21**: Post-cutover 24–72h watch.
- **22**: Decommission file path (requires explicit human approval).

## Rollback safety

Everything landed so far is **opt-in**:
- New modules (`live_exchange_fetcher`, `shadow_writer`) are not imported anywhere yet.
- `start.sh` guard only fires when `USE_SQLITE_STATE=true`.
- The 4 review-decision changes (Tasks 1–4) are localized to existing modules and have full test coverage.

The bot can be deployed off this branch today and will behave identically to master — no behavior change reaches the runtime until Tasks 7, 9, 10, 11 wire the modules in. That's intentional: the dangerous wiring is gated behind a deliberate next-session decision rather than a silent inclusion.

## Test budget

`pytest deploy-live/tests/` — 134 tests, ~0.85s.
`pytest deploy-live/tests/test_replay.py` — 6 fixtures, all green; CI gate live in `.github/workflows/replay-gate.yml`.
