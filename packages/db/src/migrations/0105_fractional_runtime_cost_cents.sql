ALTER TABLE "agent_runtime_state"
  ALTER COLUMN "total_cost_cents" TYPE numeric(20, 6)
  USING "total_cost_cents"::numeric(20, 6);
