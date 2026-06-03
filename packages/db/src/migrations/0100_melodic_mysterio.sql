-- Relax cost_events.agent_id to nullable for source-less system/timer charges
-- (agent-budgeting policy §2.1; charge writer ELI-75). Additive and back-compat:
-- existing rows all have a non-null agent_id, so no data changes.
-- Rollback (forward-only repo; only safe while no null-agent rows exist):
--   ALTER TABLE "cost_events" ALTER COLUMN "agent_id" SET NOT NULL;
ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;