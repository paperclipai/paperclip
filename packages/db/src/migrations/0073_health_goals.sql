-- Health goals: user-defined daily targets for tracked health metrics.
-- One active goal per user per goal_type (upsert on conflict).
-- Backs GET/POST/PATCH/DELETE /health/goals endpoints.

CREATE TABLE IF NOT EXISTS "health_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "goal_type" text NOT NULL,
  "target_value" integer NOT NULL,
  "unit" text NOT NULL,
  "label" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "health_goals_user_company_idx" ON "health_goals" ("user_id", "company_id");
CREATE UNIQUE INDEX "health_goals_user_type_uq" ON "health_goals" ("company_id", "user_id", "goal_type") WHERE "is_active" = true;
