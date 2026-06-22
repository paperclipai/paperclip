-- Plan ETA supervision: CTO-set estimated completion time, the agent that set it,
-- and a one-shot notified guard so the overrun wake fires exactly once per ETA.
ALTER TABLE plan_details ADD COLUMN estimated_completion_at timestamptz;
--> statement-breakpoint
ALTER TABLE plan_details ADD COLUMN estimator_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE plan_details ADD COLUMN eta_overrun_notified_at timestamptz;
