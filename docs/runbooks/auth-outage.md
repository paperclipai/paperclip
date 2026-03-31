# Auth outage runbook

1. Confirm health: `GET /api/health` and check `authReady`.
2. Validate env in running deployment:
`BETTER_AUTH_SECRET`
`PAPERCLIP_DEPLOYMENT_MODE=authenticated`
`PAPERCLIP_AUTH_BASE_URL_MODE=explicit`
`PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://app.tye.ai`
3. Check Better Auth cookie domain/protocol mismatch (must be HTTPS in public).
4. Roll back to last known-good deploy if login failures exceed SLO.
5. Rotate `BETTER_AUTH_SECRET` only with coordinated forced sign-out announcement.

