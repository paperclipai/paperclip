# PRX-44 Status: Agent Budget Calibration

## Current State (2026-08-21 ~20:05 UTC)

### Agent Budgets (from API snapshot earlier this heartbeat)

| Agent | Monthly Budget | Monthly Spent | Status |
|-------|---------------|---------------|--------|
| CEO   | $2,000.00     | $0.00         | running |
| CTO   | $1,000.00     | $0.00         | running |
| CSO   | $500.00       | $0.00         | running |
| Staff Engineer | $300.00 | $0.00         | running |
| QA Engineer | $300.00    | $0.00         | running |
| Ship Agent | $300.00     | $0.00         | idle |
| Design Agent | $300.00    | $0.00         | idle |

### Findings

1. **CEO budget is $2,000 (not $0 as stated in issue description).** The description may be stale — the budget was already configured to a reasonable amount.

2. **No real usage data yet.** All agents show `spentMonthlyCents: 0`. The cost tracking system (via `costEvents` table) hasn't accumulated any spend data. Calibration "based on real usage" requires production usage to accumulate first.

3. **Server crash-loop blocks API access.** The Paperclip API server (node + tsx) entered a crash loop around 12:08 UTC and remains down. The embedded PostgreSQL database is running but the server process cannot bind to its port. Root cause suspected to be tsx IPC pipe creation failure in TMPDIR.

4. **Budget updates require board-level access.** The `PATCH /agents/:agentId/budgets` endpoint is guarded by `assertBoard(req)` — agents cannot self-serve budget modifications. Board API key exists but server is unreachable.

### Recommendation

- **Unblock server first** (see CEO heartbeat 19:30 UTC for investigation paths).
- Once server is stable, review budgets against actual LLM API costs after ~1 week of production usage.
- Initial budgets ($300–$2,000/month) seem reasonable for the current agent population given zero usage history.
- Consider setting up budget alerting and monitoring (PRX-41) before adjusting limits.
