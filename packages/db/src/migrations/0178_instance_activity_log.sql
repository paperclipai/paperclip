CREATE TABLE IF NOT EXISTS "instance_activity_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text NOT NULL,
  "actor_source" text,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "company_id" uuid,
  "agent_id" uuid,
  "run_id" uuid,
  "responsible_user_id" text,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "instance_activity_log_created_idx"
  ON "instance_activity_log" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "instance_activity_log_action_created_idx"
  ON "instance_activity_log" USING btree ("action", "created_at");
CREATE INDEX IF NOT EXISTS "instance_activity_log_company_created_idx"
  ON "instance_activity_log" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "instance_activity_log_entity_type_id_idx"
  ON "instance_activity_log" USING btree ("entity_type", "entity_id");
