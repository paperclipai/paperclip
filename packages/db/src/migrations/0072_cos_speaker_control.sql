-- 0071: Multi-agent speaker control
-- Adds role-based routing fields so resolveMessageAudience() can pick
-- the right single speaker instead of broadcasting to all leaders.

-- 1. agents.response_topics — keyword list for topic-based routing
ALTER TABLE "agents"
  ADD COLUMN "response_topics" jsonb;

-- 2. rooms.coordinator_agent_id — manual override for default speaker
--    Falls back to linked issue assignee → room creator when NULL.
ALTER TABLE "rooms"
  ADD COLUMN "coordinator_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
