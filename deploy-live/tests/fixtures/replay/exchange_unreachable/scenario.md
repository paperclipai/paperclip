# Exchange unreachable for 60 seconds

Verifies the consecutive-failure escalation: 3 unreachable ticks against
BLOFIN should produce a `critical` exchange_unreachable event and flip
exchange_health to `down`.
