---
name: exit-event-integrity-check
description: >
  Validate the integrity of trade exit events against expected outcomes and
  historical patterns. Use when checking that position closures, stops, limits,
  or forced liquidations are consistent with declared trade rules and not
  corrupted by data pipeline errors or anomalous market conditions.
---

# Exit-Event Integrity Check

Verifies that every exit event recorded in the wallet/portfolio system is
well-formed, internally consistent, and consistent with the trade contract
that opened the position.

## Integrity Checks

For each exit event, validate:

1. **Position reference** — the exit event references a position that was
   previously opened and is still open.
2. **Size consistency** — exit size ≤ open position size; partial exits reduce
   remaining open size correctly.
3. **Price bounds** — exit price is within `[open_price × (1 - max_slippage),
   open_price × (1 + max_slippage)]` unless a known news event is tagged.
4. **Timestamp ordering** — exit_time > entry_time; no duplicate exit timestamps.
5. **Fee reconciliation** — exit fee ≤ exit_notional × max_fee_rate.
6. **P&L arithmetic** — realized P&L = (exit_price - entry_price) × size - fees,
   within ±1bps rounding tolerance.

## Output

- `valid_exits: N` — count of exit events passing all checks.
- `invalid_exits: N` — count of exit events failing one or more checks.
- For each invalid exit, emit `{exit_id, failure_reasons: string[], severity: low|medium|high|critical}`.

## Severity Guidelines

| Failure | Severity |
|---------|----------|
| Missing exit event for a closed position | critical |
| Exit size > open size | critical |
| Exit price outside slippage bounds (no news tag) | high |
| Fee overrun > 10× expected | high |
| P&L mismatch > 1bps | medium |
| Timestamp ordering violation | medium |
| Partial exit arithmetic error | low |

If any critical failures are found, halt downstream processing and alert.
