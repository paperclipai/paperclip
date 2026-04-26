# Plan 2 wiring notes (for Plan 3)

Plan 2 shipped four new modules — `normalizers.py`, `reconciler.py`,
`invariants.py`, `alerts.py` — plus a replay-test harness with 5 golden
fixtures derived from production bugs. None of them modify `real_trader.py`.
Plan 3 wires them in. This file lists the wiring points so they aren't
forgotten.

## 1. ExchangeFetcher implementation

`reconciler.py` defines an `ExchangeFetcher` Protocol with three methods:
`get_open_positions`, `get_recent_fills`, `get_balance`. Plan 3 must
provide a concrete implementation that delegates to the live trader's
existing `ExchangeExecutor` classes. Suggested file: `live_exchange_fetcher.py`.

Each method may raise `ConnectionError` on unreachability; the reconciler
catches it and updates `exchange_health` accordingly.

## 2. Normalizer integration

`normalizers.py` exposes per-exchange free functions:
- `normalize_mexc_order(raw, *, requested_size_usd) -> ExchangeOrderResponse`
- `normalize_okx_order(raw, *, requested_size_usd) -> ExchangeOrderResponse`
- `normalize_bybit_order(raw, *, requested_size_usd) -> ExchangeOrderResponse`
- `normalize_blofin_order(raw, *, requested_size_usd) -> ExchangeOrderResponse`

Plan 3 should call the appropriate normalizer from each `ExchangeExecutor.place_market_order`
(or wherever the raw response is produced) and treat the resulting `ExchangeOrderResponse`
as authoritative — most importantly its `success` flag and `filled_size_usd`. The BloFin
normalizer specifically catches the silent-failure mode (state=filled, filledSize=0)
that has caused asymmetric legs in production.

## 3. Reconciler triggers

In `real_trader.py`'s startup:
```python
sweep_task = start_periodic_sweep(
    state_store_conn, fetcher,
    exchanges=["MEXC", "BLOFIN", "OKX", "BYBIT"],
    interval_s=300.0,
)
# ... store sweep_task on the trader; cancel + await on shutdown
```

After every order placement (entry or exit) in `real_trader.py`:
```python
schedule_per_trade_reconcile(
    state_store_conn, fetcher,
    exchange=ex, symbol=sym,
)  # fire-and-forget; returns asyncio.Task that can be discarded
```

## 4. Invariants integration

In `real_trader.py`'s end-of-cycle housekeeping:
```python
violations = invariants.check_all(state_store_conn)
violations += invariants.check_inmem_consistency(
    state_store_conn,
    in_memory_open_count=len(self._open_positions),
)
for v in violations:
    if rate_limiter.allow(v):
        # Persist as a recon event, then dispatch through alerts
        eid = state_store.write_recon_event(
            state_store_conn,
            timestamp_ms=int(time.time() * 1000),
            source="invariants",
            category=v.category,
            severity=v.severity,
            exchange=v.exchange,
            symbol=v.symbol,
            position_id=v.position_id,
            expected=v.expected or None,
            actual=v.actual or None,
            notes=v.notes or None,
        )
        # Reload the persisted event so its id matches DB
        events = state_store.list_unresolved_recon_events(state_store_conn)
        event = next(e for e in events if e.timestamp_ms == ...)  # match the one just written
        await alert_dispatcher.dispatch(event)
```

(Plan 3 may want a small helper like `_violation_to_event(v) -> ReconciliationEvent`
to avoid the reload-and-search pattern. Or, extend `write_recon_event` to return
the constructed `ReconciliationEvent` alongside the id.)

## 5. Alert wiring

In `real_trader.py`'s startup:
```python
dispatcher = AlertDispatcher(dedup_window_s=60.0)
dispatcher.add_sink(
    TelegramSink(bot_token=os.environ["TELEGRAM_BOT_TOKEN"],
                 chat_id=os.environ["TELEGRAM_CHAT_ID"]),
    min_severity="warn",
)
dispatcher.add_sink(ConsoleSink(), min_severity="info")
```

The bot token + chat id come from the existing live trader environment
variables. `httpx` will need to be added to `requirements.txt` for the
real Telegram client (TelegramSink imports it lazily).

## 6. Feature flag

Plan 3 puts all of the above behind `USE_SQLITE_STATE=true` so the cutover
is reversible. Keep the file-based persistence path active until the
shadow-mode watch window passes.

## 7. Replay-test gate

CI must include `pytest tests/test_replay.py` as a pre-deploy gate. Adding
a new fixture for any future production bug becomes a hard step in the
bug-fix workflow. Fixtures live at `tests/fixtures/replay/<scenario>/`.
