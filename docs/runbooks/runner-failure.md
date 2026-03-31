# Runner failure runbook

1. Identify impacted company and runner machine id.
2. Restart or recreate runner machine (Fly Machines API).
3. Re-register runner:
`POST /api/internal/companies/:companyId/provision-runner`
4. Confirm `openclaw_gateway` defaults are still valid.
5. Trigger a manual heartbeat run for one agent in that company.
6. If repeated failures occur, deactivate tenant runner and pause company:
`POST /api/internal/companies/:companyId/deactivate`

