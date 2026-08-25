---
name: weknora-health
description: Check WeKnora availability and report partial wiki diagnostics.
---

# WeKnora Health

1. Call `weknora_health` with the selected knowledge base when known.
2. Report `ok`, `degraded`, or `unavailable` exactly.
3. Include warnings and distinguish authentication/configuration failures from partial wiki failures.
4. Never apply a lint fix from a health check.
