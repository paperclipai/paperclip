CREATE TABLE IF NOT EXISTS "company_skill_usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "skill_key" text NOT NULL,
  "skill_id" uuid REFERENCES "public"."company_skills"("id") ON DELETE set null,
  "skill_version_id" uuid REFERENCES "public"."company_skill_versions"("id") ON DELETE set null,
  "agent_id" uuid NOT NULL REFERENCES "public"."agents"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade,
  "issue_id" uuid REFERENCES "public"."issues"("id") ON DELETE set null,
  "adapter" text NOT NULL,
  "event_kind" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "company_skill_usage_events_company_created_idx" ON "company_skill_usage_events" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "company_skill_usage_events_company_skill_created_idx" ON "company_skill_usage_events" USING btree ("company_id", "skill_id", "created_at");
CREATE INDEX IF NOT EXISTS "company_skill_usage_events_company_skill_key_created_idx" ON "company_skill_usage_events" USING btree ("company_id", "skill_key", "created_at");
