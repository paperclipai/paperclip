# Size mismatch from a partial fill

State store believes a position of $25.00 USD is open on MEXC for ORDIUSDT (buy).
On the next reconcile tick, MEXC reports the same symbol/side open but at
$18.50 USD — a partial fill happened that the bot's per-trade reconcile
missed (perhaps the bot's view was captured between the place_market_order
return and the partial-fill confirmation). The 5-min sweep should detect
this as `size_mismatch` warn.

Differences from `unlinked_fill`: the order_id IS in state_store; only the
size is wrong. Differences from `orphan_leg`: the position IS still on the
exchange; just at a different size.

Plan 3 task 16 — fills the gap noted in PLAN2_NOTES §8g (replay coverage
for the size_mismatch detection path).
