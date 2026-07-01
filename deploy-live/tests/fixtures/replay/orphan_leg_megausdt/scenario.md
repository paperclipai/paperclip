# Orphan leg: MEGAUSDT stuck open on MEXC

Reproduces production bug P1175: a position was opened on MEXC and BLOFIN.
BLOFIN's leg closed externally (or never confirmed), but MEXC's leg remains
open. The bot's state still thinks both legs are open. Reconciler should
report `orphan_leg` against BLOFIN (state_store has it, exchange doesn't).
