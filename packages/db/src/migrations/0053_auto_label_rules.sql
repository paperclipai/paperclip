CREATE TABLE IF NOT EXISTS "auto_label_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "trigger_event" text NOT NULL,
  "condition_expression" text NOT NULL,
  "action" text NOT NULL,
  "label_id" uuid NOT NULL REFERENCES "labels"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 0,
  "created_by_user_id" uuid,
  "created_by_agent_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_label_rule_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" uuid NOT NULL REFERENCES "auto_label_rules"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "trigger_event_type" text NOT NULL,
  "condition_result" boolean NOT NULL,
  "action_taken" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_label_rules_company_idx" ON "auto_label_rules" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_label_rules_company_trigger_idx" ON "auto_label_rules" USING btree ("company_id", "trigger_event");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auto_label_rules_company_name_idx" ON "auto_label_rules" USING btree ("company_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_label_rule_executions_rule_idx" ON "auto_label_rule_executions" USING btree ("rule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_label_rule_executions_issue_idx" ON "auto_label_rule_executions" USING btree ("issue_id");
