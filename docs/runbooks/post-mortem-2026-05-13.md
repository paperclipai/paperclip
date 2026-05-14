# Post-Mortem: Paperclip Slowdown Incident (2026-05-13)

## Summary

On 2026-05-13, `paperclip.thegoodguys.la` degraded into stalled pages and hung issue operations.  
Primary symptom: API polling storm saturated node process resources and amplified connection pressure.

## Impact

- Dashboard actions became unreliable or hung.
- Agent/issue workflows slowed significantly.
- Elevated CPU and socket pressure on app host.
- Excessive log growth increased disk-risk posture.

## Timeline (UTC)

1. User-visible stalls observed on dashboard and issue interactions.
2. Host triage showed elevated CPU and high active socket counts.
3. API path mismatch + retry loop identified as core traffic amplifier.
4. Log growth and absent hard caps identified as compounding factor.
5. Manual recovery steps stabilized service.
6. Reliability hardening program (THE-448) initiated and executed.

## Root Cause

- Frontend/API route mismatch enabled repeated 404 retries on hot polling paths.
- No effective guardrails for burst request patterns at server edge.

## Contributing Factors

- Missing/insufficient request backpressure controls.
- Missing standardized log rotation policy.
- Limited pre-impact health/metrics alert coverage.
- No automated local watchdog remediation path.
- Cloudflare security mode produced false positives under this traffic shape.

## What Changed (Action Items Shipped)

- **PR1**: API compatibility guard + regression coverage for heartbeat log endpoints.
- **PR2**: Per-IP rate limiting, timeout policy, SSE log stream path, hidden-tab backoff.
- **PR3**: Log-level discipline + committed logrotate policy + install docs.
- **PR4**: `/healthz` + `/metrics` with required reliability fields and series.
- **PR5**: Watchdog script, systemd timer/service, dry-run/enforce switch, flap protection.
- **PR6**: Cloudflare IaC scaffolding + access/bot/security runbook + tunnel token rotation script.
- **PR7**: Incident and alerting runbooks (this document set).

## Detection and Alerting Improvements

- Health status monitored via `/healthz`.
- Prometheus-compatible metrics exposed via `/metrics`.
- Watchdog emits Telegram + Paperclip Proposal events for critical actions/escalations.

## Residual Risks

- Cloudflare Terraform and token rotation still require production credentialed apply.
- Alert threshold tuning may need one dry-run iteration after live rollout.

## Follow-up

1. Execute Cloudflare Terraform apply in production environment.
2. Run watchdog 48h dry-run and review action logs.
3. Confirm alert payload quality and operator response loop.
4. Close THE-448 after production verification checklist is complete.

