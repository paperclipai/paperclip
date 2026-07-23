# Zero fill price audit (P980)

The audit log historically displayed a fill_price=0 for some entries,
because the schema didn't enforce > 0. Plan 1's CHECK constraint now
prevents this at the SQL level, and Plan 2's normalizers reject it at
the boundary. This fixture verifies that the protection holds: an
exchange_response with fill_price=0 produces no fills in state_store
and no orphan-leg violation, because nothing was committed.

In practice, this fixture has no state seed (no pre-existing position),
just an exchange_response showing a fill the bot never recorded.
Reconciler should report `unlinked_fill`.
