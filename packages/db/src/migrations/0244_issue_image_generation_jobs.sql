CREATE TABLE "issue_image_generation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "request" jsonb NOT NULL,
  "reference_snapshot" jsonb NOT NULL,
  "actor" jsonb NOT NULL,
  "request_fingerprint" text NOT NULL,
  "last_error" text,
  "lease_expires_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "output_attachment_id" uuid,
  "audit_attachment_id" uuid,
  "terminal_audit" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "issue_image_generation_jobs"
  ADD CONSTRAINT "issue_image_generation_jobs_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_image_generation_jobs"
  ADD CONSTRAINT "issue_image_generation_jobs_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "issue_image_generation_jobs"
  ADD CONSTRAINT "issue_image_generation_jobs_output_attachment_id_issue_attachments_id_fk"
  FOREIGN KEY ("output_attachment_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "issue_image_generation_jobs"
  ADD CONSTRAINT "issue_image_generation_jobs_audit_attachment_id_issue_attachments_id_fk"
  FOREIGN KEY ("audit_attachment_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "issue_image_generation_jobs_issue_idx"
  ON "issue_image_generation_jobs" USING btree ("company_id","issue_id","created_at");
CREATE INDEX "issue_image_generation_jobs_status_idx"
  ON "issue_image_generation_jobs" USING btree ("status","created_at");
CREATE INDEX "issue_image_generation_jobs_lease_idx"
  ON "issue_image_generation_jobs" USING btree ("status","lease_expires_at");
CREATE UNIQUE INDEX "issue_image_generation_jobs_issue_idempotency_uq"
  ON "issue_image_generation_jobs" USING btree ("issue_id","idempotency_key");
