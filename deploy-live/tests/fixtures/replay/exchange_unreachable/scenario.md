# Exchange unreachable for 60 seconds

Verifies the consecutive-failure escalation: 3 unreachable ticks against
BLOFIN should produce ONE `exchange_unreachable` event that escalates
from `error` to `critical` (Plan 3 Task 2 — `upsert_recon_event` dedups
unresolved events for the same key) and flips exchange_health to `down`.
