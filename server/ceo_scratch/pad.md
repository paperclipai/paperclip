# PRX-44 Phase 4: Calibrate Agent Budgets Based on Real Usage

## Heartbeat Final — 2026-08-21 ~20:55 UTC

---

## Status: BLOCKED — Infrastructure

### Blockers
1. **Database reset** — embedded PostgreSQL was re-initialized, losing all company/agent/issue data
2. **Board claim required** — human must sign in and claim instance admin
3. **Server crash-loop** — port conflicts, multiple instances, postgres connection drops
4. **Agent credentials invalid** — CEO agent record no longer exists

### What Was Accomplished

#### ✅ Budget Data Captured (before DB loss)
Complete budget state for all 7 agents was queried and documented:

| Agent | Budget ($/mo) | Has Policy? | Status |
|-------|--------------|-------------|--------|
| CEO | $2000 | NO | running |
| CTO | $1000 | NO | running |
| CSO | $500 | YES | idle |
| Design Agent | $300 | YES | idle |
| Ship Agent | $300 | NO | idle |
| QA Engineer | $300 | NO | running |
| Staff Engineer | $300 | NO | running |
| **Total** | **$4700** | **2/7 synced** | |

**Critical finding:** The issue description says "CEO has $0 budget" but the actual budget was **$2000/month**. Outdated description.

#### ✅ Missing Policy Gap Identified
5 of 7 agents had `budget_monthly_cents` on the agents table but **no corresponding row in `budget_policies`**. Without a policy row, the hard-stop enforcement (the mechanism that pauses an agent when it exceeds budget) will NOT trigger. The `budgetService.upsertPolicy` function syncs both the policy table AND the agent's `budget_monthly_cents` field — using this endpoint would fix the gap.

#### ✅ pgvector Extension Fixed
Migration 0229 requires `CREATE EXTENSION vector;` but embedded PostgreSQL didn't have pgvector installed. Fixed by copying pgvector 0.8.2 files from homebrew (supports PG18) to the embedded postgres native directory at:
- `node_modules/.pnpm/@embedded-postgres+darwin-arm64@18.1.0-beta.16/node_modules/@embedded-postgres/darwin-arm64/native/lib/postgresql/vector.dylib`
- `.../share/postgresql/extension/vector*`

#### ✅ Budget System Understood
Reviewed `server/src/services/budgets.ts` — supports company/agent/project scopes, calendar_month_utc/lifetime windows, soft/hard thresholds with approval workflow. `getInvocationBlock` checks budget before allowing new runs.

#### ✅ Usage Data Checked
Zero cost events in `cost_events` table. No real usage data exists to calibrate against. Initial budgets of $4700/mo total appear reasonable as starting estimates.

### Recommendations (for when infrastructure is restored)

1. Restore database from backup at `~/.paperclip/instances/default/data/backups/paperclip-20260821-112543.sql.gz`
2. Or re-seed company configuration and re-hire all 7 agents
3. Create budget policies for all agents via POST `/api/companies/{companyId}/budgets/policies`
4. Monitor for 30 days, then adjust based on actual cost events
5. Update issue description from "CEO has $0 budget" to accurate values

### Git History
- `b994d99053` — docs(ceo): PRX-44 budget calibration findings
