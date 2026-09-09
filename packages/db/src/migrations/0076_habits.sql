CREATE TABLE IF NOT EXISTS "habit_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "color" text NOT NULL DEFAULT '#6366f1',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "habit_definitions_user_company_idx" ON "habit_definitions" ("user_id", "company_id");

CREATE TABLE IF NOT EXISTS "habit_completions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "habit_id" uuid NOT NULL REFERENCES "habit_definitions"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "completion_date" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "habit_completions_habit_date_uq" ON "habit_completions" ("habit_id", "completion_date");
CREATE INDEX "habit_completions_user_company_idx" ON "habit_completions" ("user_id", "company_id", "completion_date");
