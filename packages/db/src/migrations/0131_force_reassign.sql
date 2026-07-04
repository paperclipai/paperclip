ALTER TABLE "issues"
  ADD COLUMN "assignee_uninvokable" text NOT NULL DEFAULT 'false',
  ADD COLUMN "assignee_uninvokable_at" timestamp with time zone,
  ADD COLUMN "assignee_liveness_status" text NOT NULL DEFAULT 'unknown',
  ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "agents"
  ADD COLUMN "status_changed_by" uuid,
  ADD COLUMN "status_changed_at" timestamp with time zone,
  ADD COLUMN "manager_changed_by" uuid,
  ADD COLUMN "manager_changed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "security_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" integer NOT NULL,
  "event_type" text NOT NULL DEFAULT 'ISSUE_FORCE_REASSIGN',
  "tenant_id" text NOT NULL,
  "issue_id" uuid REFERENCES "issues"("id"),
  "actor_id" text NOT NULL,
  "actor_role" text,
  "actor_scopes" jsonb,
  "from_assignee_id" uuid REFERENCES "agents"("id"),
  "from_assignee_status" text,
  "from_chain_snapshot" jsonb,
  "to_assignee_id" uuid REFERENCES "agents"("id"),
  "to_assignee_status" text,
  "orphan_evidence" jsonb,
  "reason" text NOT NULL,
  "lease_action" text,
  "issue_version_before" integer,
  "issue_version_after" integer,
  "idempotency_key" text,
  "request_id" text,
  "dual_control_confirmer_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "prev_hash" text,
  "hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_audit_log_tenant_seq_idx" ON "security_audit_log" USING btree ("tenant_id", "seq");
--> statement-breakpoint
CREATE INDEX "security_audit_log_tenant_created_idx" ON "security_audit_log" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX "security_audit_log_issue_idx" ON "security_audit_log" USING btree ("issue_id");
--> statement-breakpoint
CREATE TABLE "force_reassign_idempotency" (
  "idempotency_key" text PRIMARY KEY NOT NULL,
  "issue_id" uuid REFERENCES "issues"("id"),
  "response_body" jsonb,
  "audit_id" uuid REFERENCES "security_audit_log"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "force_reassign_idempotency_created_idx" ON "force_reassign_idempotency" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "issues_company_liveness_status_idx" ON "issues" USING btree ("company_id", "assignee_liveness_status", "status");
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "security_audit_log" FROM PUBLIC;