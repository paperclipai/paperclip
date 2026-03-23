CREATE TABLE IF NOT EXISTS "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "agent_id" uuid REFERENCES "agents"("id"),
  "issue_id" uuid REFERENCES "issues"("id"),
  "heartbeat_run_id" uuid REFERENCES "heartbeat_runs"("id"),
  "type" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "content_type" text,
  "content_text" text,
  "content_ref" text,
  "size_bytes" integer,
  "metadata" jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_company_idx" ON "artifacts" ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_agent_idx" ON "artifacts" ("company_id", "agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_issue_idx" ON "artifacts" ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_type_idx" ON "artifacts" ("company_id", "type");
