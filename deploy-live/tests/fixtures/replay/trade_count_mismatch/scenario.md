# Trade count mismatch (P1180, P1213)

Dashboard previously displayed inconsistent counts (total trades, attempted
trades, win rate computed from divergent sources). The new design routes
all reads through state_store, so the counts are derived from the same
table. This fixture has 0 positions and verifies no false-positive
violations fire on a clean tick.
