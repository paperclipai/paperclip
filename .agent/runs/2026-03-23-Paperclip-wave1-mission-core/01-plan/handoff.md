# Plan: Wave 1 — Mission Core (Phases A + B + D)

## Objective
Build the autonomous mission engine that enables AI agents to work toward user-defined goals with budget constraints, risk-tiered approvals, and auto-approve timers. This is the foundation that transforms Paperclip from a control panel into a "company that runs itself."

## Business Outcome
A founder can:
1. Create a mission (e.g., "Reach $1K MRR by April 30")
2. Set a budget cap ($20) and autonomy level (copilot)
3. Watch agents execute autonomously within constraints
4. Receive Telegram notifications for yellow/red decisions
5. Tap to approve/reject from phone
6. See budget spent and mission progress on dashboard

**Success metric:** Mission creation → first agent action in < 5 minutes.

## In Scope
- Database schema: `missions`, `mission_approval_rules`, `mission_notification_channels`, extend `approvals` table
- XState mission state machine (draft → active → paused → completed/failed)
- BullMQ + Redis job queue for auto-approve timers
- 5 new agent tools: `get_active_mission`, `propose_action`, `get_company_metrics`, `get_revenue_trend`, `get_integration_status`
- Mission CRUD API routes
- Agent metrics API endpoints
- Default approval rules seeded on mission creation
- Telegram inline approval buttons (extend existing service)
- Idempotent approval resolve endpoint (race condition safe)

## Out of Scope
- Mission Board UI (Wave 3, Phase G)
- Email/Web Push adapters (Wave 2, Phase C)
- Company Brain knowledge docs (Wave 2, Phase F)
- Social/Deploy integrations (Wave 3, Phase E)
- PWA + swipe gestures (Wave 3, Phase G)
- Crypto payments (Wave 3, Phase E)
- Templates + export/import (Wave 3, Phase H)

## Touch List

### Database Layer
- `packages/db/src/schema/missions.ts` — CREATE
- `packages/db/src/schema/mission_approval_rules.ts` — CREATE
- `packages/db/src/schema/mission_notification_channels.ts` — CREATE
- `packages/db/src/schema/index.ts` — EDIT (export new tables)
- `packages/db/src/schema/approvals.ts` — EDIT (add 5 new columns)
- `packages/db/src/migrations/` — GENERATE migrations

### Shared Layer
- `packages/shared/src/types/mission.ts` — CREATE (types + validators)
- `packages/shared/src/types/index.ts` — EDIT (export mission types)

### Server Layer
- `server/src/services/mission-engine.ts` — CREATE (XState machine + CRUD)
- `server/src/services/queue.ts` — CREATE (BullMQ setup)
- `server/src/services/jobs/approve-timer.ts` — CREATE (auto-approve job)
- `server/src/services/agent-metrics.ts` — CREATE (metrics aggregation)
- `server/src/routes/missions.ts` — CREATE (CRUD + state transitions)
- `server/src/routes/agent-tools.ts` — CREATE (agent tool endpoints)
- `server/src/routes/approvals.ts` — CREATE (idempotent resolve endpoint)
- `server/src/routes/telegram-callback.ts` — CREATE (callback handler)
- `server/src/routes/index.ts` — EDIT (mount new routes)
- `server/src/index.ts` — EDIT (start queue workers on boot)
- `server/src/services/telegram-notifier.ts` — EDIT (add inline keyboard method)
- `server/package.json` — EDIT (add xstate, bullmq, ioredis, node-telegram-bot-api, web-push)

### Tests
- `server/src/__tests__/mission-engine.test.ts` — CREATE
- `server/src/__tests__/missions.test.ts` — CREATE
- `server/src/__tests__/queue.test.ts` — CREATE
- `server/src/__tests__/approve-timer.test.ts` — CREATE
- `server/src/__tests__/agent-metrics.test.ts` — CREATE
- `server/src/__tests__/approvals-resolve.test.ts` — CREATE

### Infrastructure
- `docker-compose.yml` — EDIT (add Redis service)
- `docker-compose.quickstart.yml` — EDIT (add Redis)

### External (outside repo)
- `~/.paperclip/workers/multi_model_worker.py` — EDIT (add 5 new tool definitions)

## Task Breakdown

### Phase A — Mission Foundation
- [ ] A1: Add xstate package, create mission DB schema (3 tables + approvals extension)
- [ ] A2: Create shared types and validators for missions
- [ ] A3: Build mission-engine.ts with XState machine + default approval rules
- [ ] A4: Create mission API routes (CRUD + state transitions)
- [ ] Verify: Typecheck passes, tests pass, POST/GET missions works

### Phase B — BullMQ Job Queue
- [ ] B1: Add Redis to docker-compose, install bullmq + ioredis
- [ ] B2: Create queue.ts infrastructure (Queue + Worker helpers)
- [ ] B3: Implement approve-timer.ts job (delayed auto-approve)
- [ ] B4: Start worker in server boot, test timer cancel on manual resolve
- [ ] Verify: Redis running, timer job enqueued, auto-approve fires after delay

### Phase D — Agent Metrics Tools
- [ ] D1: Create agent-metrics.ts service (MRR, users, bugs, mission lookup)
- [ ] D2: Create agent-tools.ts routes (5 endpoints for new tools)
- [ ] D3: Extend telegram-notifier.ts with sendApprovalRequest (inline keyboard)
- [ ] D4: Create telegram-callback.ts route (handle button taps)
- [ ] D5: Update multi_model_worker.py with 5 new tool definitions
- [ ] Verify: Agent can call tools, metrics returned, Telegram buttons work

## Verification Commands

```bash
# Typecheck
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/shared typecheck

# Tests
pnpm --filter @paperclipai/server test server/src/__tests__/mission-engine.test.ts
pnpm --filter @paperclipai/server test server/src/__tests__/missions.test.ts
pnpm --filter @paperclipai/server test server/src/__tests__/queue.test.ts
pnpm --filter @paperclipai/server test server/src/__tests__/approve-timer.test.ts
pnpm --filter @paperclipai/server test server/src/__tests__/agent-metrics.test.ts
pnpm --filter @paperclipai/server test server/src/__tests__/approvals-resolve.test.ts

# API verification
curl -s http://localhost:3100/api/health | python3 -m json.tool
curl -s http://localhost:3100/api/companies/<company-id>/missions | python3 -m json.tool

# Redis check
docker-compose ps redis
redis-cli ping

# Start server
cd Paperclip/server && PAPERCLIP_MIGRATION_PROMPT=never npx tsx src/index.ts
```

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| XState transition logic incorrect | High | Write 6 unit tests covering all valid/invalid transitions |
| BullMQ timer fires twice (race condition) | High | Use atomic DB update with `status = 'pending'` WHERE clause |
| Telegram callback not acknowledged within 3s | Medium | Immediately `res.sendStatus(200)` before processing |
| Redis not running in dev | Medium | Add Redis to docker-compose, document in .env.example |
| Python worker tool definitions mismatch | High | Copy exact tool schemas from design doc, test with curl |
| Migration order incorrect | High | Execute migrations in strict order A→B→D, verify with pnpm db:migrate |
| Approvals table column conflict | Medium | Use ALTER TABLE migration, don't edit original schema |

## Rollback Plan

If Wave 1 fails:
```bash
# 1. Stop server
pkill -f "tsx src/index.ts"

# 2. Revert DB migrations
cd Paperclip/packages/db
pnpm db:rollback  # rollback last 3 migrations

# 3. Revert code changes
cd Paperclip
git checkout -- packages/db/src/schema/ packages/shared/src/types/ server/src/

# 4. Stop Redis
docker-compose down redis

# 5. Restart server
cd Paperclip/server && PAPERCLIP_MIGRATION_PROMPT=never npx tsx src/index.ts
```

## Quality Gates (Run in Order)

1. `pnpm -r typecheck` — 0 errors
2. `pnpm test` — all new tests pass
3. `pnpm build` — build succeeds
4. Playwright verification — Mission API works end-to-end
5. Staff engineer review — Would a staff engineer approve this?

## Definition of Done

Wave 1 is complete when:
- ✅ All 6 test files pass
- ✅ Typecheck passes on server + shared
- ✅ Mission can be created via API
- ✅ State transitions work (draft → active → completed)
- ✅ BullMQ timer enqueues and fires correctly
- ✅ Agent tools return correct data
- ✅ Telegram inline buttons work (manual test)
- ✅ Idempotent approval resolve prevents race conditions
- ✅ PHASE_STATE.md updated
- ✅ Vault progress synced

---

**Run ID:** `2026-03-23-Paperclip-wave1-mission-core`
**Risk Level:** CRITICAL (10+)
**Temperature:** 0.1
**Recommended Model:** qwen3-coder-plus (code execution)
**Start Date:** 2026-03-23
