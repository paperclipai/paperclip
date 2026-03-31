# DB outage runbook

1. Verify DB reachability from app hosts.
2. Confirm `DATABASE_URL` has not changed unexpectedly.
3. Check Neon status and connection limits.
4. Fail over to read-only status page if write path is unavailable.
5. Restore from latest verified backup if corruption is confirmed.
6. After recovery, run smoke checks:
`/api/health`
auth sign-in
company list
invite create

