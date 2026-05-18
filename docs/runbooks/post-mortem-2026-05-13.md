# Post-Mortem: 2026-05-13 Paperclip Production Slowdown

## Timeline (UTC)

- **~16:00** — Paperclip dashboard begins responding slowly.
- **~16:05** — Issue creation hangs. API requests start timing out.
- **~16:10** — Manual investigation begins via SSH to Hetzner VM.
- **~16:15** — CPU identified at 154% on the Node process.
- **~16:20** — 119 open sockets identified; multi-MB send buffers.
- **~16:25** — Root cause identified: frontend `/api` prefix mismatch causing 404 retry loop.
- **~16:30** — `cloudflared-paperclip.service` restarted; connections cleared.
- **~16:35** — `paperclip.service` restarted; service recovered.
- **~16:40** — `server.log` identified at 700 MB (75% disk).
- **~16:45** — Cloudflare Bot Fight Mode identified as compounding factor.

## Root Cause

Frontend calls to `/api/heartbeat-runs/...` and `/api/companies/...` returned 404 because the server routes were at `/heartbeat-runs/...` and `/companies/...` (no `/api` prefix). The frontend retried on failure, creating a self-reinforcing polling storm.

## Contributing Factors

1. **No rate limiting** — the polling storm was unbounded.
2. **No log rotation** — `server.log` grew to 700 MB.
3. **No connection limits** — 119 concurrent sockets, multi-MB send buffers.
4. **Cloudflare Bot Fight Mode** — false-positives on legitimate API polling.
5. **No observability** — no health checks, metrics, or alerts.
6. **No auto-remediation** — required manual SSH and triage.

## Impact

- ~35 minutes of degraded service.
- Manual intervention required (SSH + terminal).
- No data loss.

## Action Items

| PR | Description | Status |
|----|-------------|--------|
| PR 1 | Fix `/api` prefix mismatch (dual prefix mount) | Done |
| PR 2 | Server hardening (rate limiting, timeouts, SSE) | Done |
| PR 3 | Log rotation + log level discipline | Done |
| PR 4 | Observability (`/healthz`, `/metrics`, monitoring) | Done |
| PR 5 | Auto-remediation (watchdog + systemd timer) | Done |
| PR 6 | Cloudflare hygiene (Bot Fight OFF, Access, Terraform) | Done |
| PR 7 | Runbooks (incident, post-mortem, alerting, cloudflare) | Done |

## Lessons Learned

1. **Every API surface needs rate limiting.** Internal polling is as dangerous as external abuse.
2. **Log rotation is not optional.** A 700 MB log file masks the actual problem.
3. **Observability must precede incidents.** Without health checks and metrics, there is no early warning.
4. **Auto-remediation reduces MTTR.** Manual SSH should be the last resort, not the first response.
5. **Cloudflare Bot Fight Mode is incompatible with API polling.** Use Access policies instead.
