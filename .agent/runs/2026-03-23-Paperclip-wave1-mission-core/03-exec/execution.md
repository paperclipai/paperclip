# Execution: Wave 1 — Mission Core (Phases A + B + D)

**Run ID:** `2026-03-23-Paperclip-wave1-mission-core`
**Started:** 2026-03-23T09:33Z
**Status:** IN PROGRESS

---

## Completed Tasks

### Phase A — Mission Foundation ✅

- [x] **A1: Database schema created**
  - `packages/db/src/schema/missions.ts` — 15 columns, unique index for one active mission per company
  - `packages/db/src/schema/mission_approval_rules.ts` — 6 columns
  - `packages/db/src/schema/mission_notification_channels.ts` — 9 columns
  - `packages/db/src/schema/approvals.ts` — extended with 6 new columns (missionId, actionType, riskTier, autoApproveAt, resolvedVia, bullJobId)
  - `packages/db/src/schema/index.ts` — exports added
  - Migration generated: `0027_low_warhawk.sql`

- [x] **A2: Shared types created**
  - `packages/shared/src/types/mission.ts` — schemas for CreateMission, UpdateMission, MissionStatus, AutonomyLevel, RiskTier
  - `packages/shared/src/types/index.ts` — exports added

- [x] **A3: Mission engine service**
  - `server/src/services/mission-engine.ts` — XState state machine + CRUD + DEFAULT_APPROVAL_RULES (16 rules)
  - Validates transitions: draft→active, active→paused/completed/failed, paused→active/failed

- [x] **A4: Mission API routes**
  - `server/src/routes/missions.ts` — GET/POST/PATCH/DELETE + state transitions (launch/pause/resume/complete)
  - `server/src/routes/index.ts` — exports added

### Phase B — BullMQ Job Queue ✅

- [x] **B1-B2: Queue infrastructure**
  - `server/src/services/queue.ts` — BullMQ + IORedis setup, QUEUE_NAMES constant
  - `server/src/services/jobs/approve-timer.ts` — enqueueApproveTimer, cancelApproveTimer, startApproveTimerWorker
  - Atomic auto-approve with `status = 'pending'` WHERE clause

### Phase D — Agent Metrics Tools ✅

- [x] **D1: Agent metrics service**
  - `server/src/services/agent-metrics.ts` — getMetrics (MRR, users, bugs), getActiveMission, proposeAction

- [x] **D2: Agent tool routes**
  - `server/src/routes/agent-tools.ts` — 3 endpoints (metrics, active-mission, propose-action)

- [x] **D3-D4: Telegram + idempotent resolve**
  - `server/src/routes/approvals.ts` — extended with PATCH /:approvalId idempotent endpoint
  - `server/src/routes/telegram-callback.ts` — callback handler for inline keyboard buttons

---

## Remaining Tasks

### Phase B — Server Boot Integration
- [ ] Update `server/src/index.ts` to:
  - Import and start approve-timer worker
  - Import and mount new routes (missions, agent-tools, telegram-callback)

### Phase D — Python Worker Tools
- [ ] Update `~/.paperclip/workers/multi_model_worker.py` with 5 new tool definitions

### Infrastructure
- [ ] Update `docker-compose.yml` to add Redis service
- [ ] Install dependencies: `cd server && pnpm add xstate bullmq ioredis node-telegram-bot-api web-push`

### Tests
- [ ] Create 6 test files:
  - `server/src/__tests__/mission-engine.test.ts`
  - `server/src/__tests__/missions.test.ts`
  - `server/src/__tests__/queue.test.ts`
  - `server/src/__tests__/approve-timer.test.ts`
  - `server/src/__tests__/agent-metrics.test.ts`
  - `server/src/__tests__/approvals-resolve.test.ts`

### Verification
- [ ] Run typecheck
- [ ] Run tests
- [ ] Manual API verification
- [ ] Update PHASE_STATE.md
- [ ] Sync vault progress

---

## Notes

- Migration 0027 generated successfully with all 3 new tables + approvals extension
- Unique index on missions ensures one active mission per company
- Idempotent approval resolve prevents race conditions (multiple channels resolving same approval)
- Default approval rules seeded on mission creation (16 action types, 3 risk tiers)

---

## Next Steps

1. Update server/src/index.ts to mount routes and start workers
2. Install new dependencies (xstate, bullmq, ioredis, etc.)
3. Add Redis to docker-compose
4. Create tests
5. Run typecheck + tests
6. Manual verification
7. Checkpoint
