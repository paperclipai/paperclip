CREATE TABLE "linear_evidence_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "paperclip_issue_id" uuid NOT NULL,
  "mapping_key" text NOT NULL,
  "linear_issue_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_evidence_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mapping_id" uuid NOT NULL,
  "paperclip_issue_updated_at" timestamp with time zone NOT NULL,
  "evidence_sha256" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "evidence_json" jsonb NOT NULL,
  "comment_body_sha256" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "remote_comment_id" text,
  "published_at" timestamp with time zone,
  "lease_token" text,
  "lease_expires_at" timestamp with time zone,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_evidence_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mapping_id" uuid NOT NULL,
  "conflict_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "paperclip_value" jsonb NOT NULL,
  "linear_value" jsonb NOT NULL,
  "resolution" text DEFAULT 'unresolved' NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" text,
  "resolved_by_agent_id" uuid
);
--> statement-breakpoint
ALTER TABLE "linear_evidence_mappings" ADD CONSTRAINT "linear_evidence_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "linear_evidence_mappings" ADD CONSTRAINT "linear_evidence_mappings_paperclip_issue_id_issues_id_fk" FOREIGN KEY ("paperclip_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "linear_evidence_deliveries" ADD CONSTRAINT "linear_evidence_deliveries_mapping_id_linear_evidence_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."linear_evidence_mappings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "linear_evidence_conflicts" ADD CONSTRAINT "linear_evidence_conflicts_mapping_id_linear_evidence_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."linear_evidence_mappings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "linear_evidence_conflicts" ADD CONSTRAINT "linear_evidence_conflicts_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_evidence_mappings_issue_uq" ON "linear_evidence_mappings" USING btree ("paperclip_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_evidence_mappings_key_uq" ON "linear_evidence_mappings" USING btree ("mapping_key");
--> statement-breakpoint
CREATE INDEX "linear_evidence_mappings_company_idx" ON "linear_evidence_mappings" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_evidence_deliveries_idempotency_uq" ON "linear_evidence_deliveries" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "linear_evidence_deliveries_mapping_version_idx" ON "linear_evidence_deliveries" USING btree ("mapping_id", "paperclip_issue_updated_at", "created_at");
--> statement-breakpoint
CREATE INDEX "linear_evidence_deliveries_lease_idx" ON "linear_evidence_deliveries" USING btree ("state", "lease_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_evidence_conflicts_fingerprint_uq" ON "linear_evidence_conflicts" USING btree ("mapping_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX "linear_evidence_conflicts_unresolved_idx" ON "linear_evidence_conflicts" USING btree ("mapping_id", "resolution", "detected_at");
