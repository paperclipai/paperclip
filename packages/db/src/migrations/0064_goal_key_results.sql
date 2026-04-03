-- Goal Key Results: OKR key results linked to goals.

CREATE TABLE IF NOT EXISTS "goal_key_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "target_value" numeric NOT NULL DEFAULT 100,
  "current_value" numeric NOT NULL DEFAULT 0,
  "unit" text NOT NULL DEFAULT '%',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "goal_key_results_goal_idx" ON "goal_key_results" ("goal_id");
