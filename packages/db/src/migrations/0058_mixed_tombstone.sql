CREATE TABLE "truth_atoms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"truth_run_id" uuid NOT NULL,
	"truth_document_id" uuid NOT NULL,
	"truth_document_chunk_id" uuid,
	"raw_atom_id" text,
	"atom_index" integer NOT NULL,
	"ledger_section" text NOT NULL,
	"atom_type" text NOT NULL,
	"atom_text" text NOT NULL,
	"durability_score" integer NOT NULL,
	"confidence_score" numeric NOT NULL,
	"evidence_mode" text NOT NULL,
	"speaker_name" text,
	"speaker_id" text,
	"start_time" text,
	"end_time" text,
	"source_utterance_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_quote" text NOT NULL,
	"planning_relevance" text,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"audit_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"truth_run_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"brief_kind" text NOT NULL,
	"content_markdown" text,
	"content_json" jsonb,
	"canonical_input" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"template_version" text NOT NULL,
	"model" text,
	"input_hash" text NOT NULL,
	"payload_hash" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_document_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"truth_document_id" uuid NOT NULL,
	"source_chunk_key" text NOT NULL,
	"deterministic_key" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_kind" text DEFAULT 'text' NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"content_sha256" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_slug" text NOT NULL,
	"title" text,
	"source_type" text NOT NULL,
	"source_uri" text,
	"source_sha256" text,
	"ingest_status" text DEFAULT 'pending' NOT NULL,
	"embedding_status" text DEFAULT 'not_required' NOT NULL,
	"exclusion_status" text DEFAULT 'included' NOT NULL,
	"mapping_confidence" numeric,
	"mapping_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"truth_run_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"html_content" text,
	"file_path" text,
	"content_sha256" text,
	"brief_input_hash" text NOT NULL,
	"brief_payload_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"template_version" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_agent_id" uuid,
	"generated_by_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_promotion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_slug" text NOT NULL,
	"truth_run_id" uuid,
	"brief_id" uuid,
	"dossier_id" uuid,
	"requested_by" text NOT NULL,
	"request_reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_run_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"truth_run_id" uuid NOT NULL,
	"audit_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auditor_model" text,
	"prompt_version" text NOT NULL,
	"template_version" text,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truth_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_slug" text NOT NULL,
	"truth_document_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"extraction_version" text DEFAULT 'truth_atom_extractor_v1' NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"source_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "allowed_company_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "board_api_keys" ADD COLUMN "allowed_company_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "truth_atoms" ADD CONSTRAINT "truth_atoms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_atoms" ADD CONSTRAINT "truth_atoms_truth_run_id_truth_runs_id_fk" FOREIGN KEY ("truth_run_id") REFERENCES "public"."truth_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_atoms" ADD CONSTRAINT "truth_atoms_truth_document_id_truth_documents_id_fk" FOREIGN KEY ("truth_document_id") REFERENCES "public"."truth_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_atoms" ADD CONSTRAINT "truth_atoms_truth_document_chunk_id_truth_document_chunks_id_fk" FOREIGN KEY ("truth_document_chunk_id") REFERENCES "public"."truth_document_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_briefs" ADD CONSTRAINT "truth_briefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_briefs" ADD CONSTRAINT "truth_briefs_truth_run_id_truth_runs_id_fk" FOREIGN KEY ("truth_run_id") REFERENCES "public"."truth_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_briefs" ADD CONSTRAINT "truth_briefs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_document_chunks" ADD CONSTRAINT "truth_document_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_document_chunks" ADD CONSTRAINT "truth_document_chunks_truth_document_id_truth_documents_id_fk" FOREIGN KEY ("truth_document_id") REFERENCES "public"."truth_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_documents" ADD CONSTRAINT "truth_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_dossiers" ADD CONSTRAINT "truth_dossiers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_dossiers" ADD CONSTRAINT "truth_dossiers_truth_run_id_truth_runs_id_fk" FOREIGN KEY ("truth_run_id") REFERENCES "public"."truth_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_dossiers" ADD CONSTRAINT "truth_dossiers_brief_id_truth_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."truth_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_dossiers" ADD CONSTRAINT "truth_dossiers_generated_by_agent_id_agents_id_fk" FOREIGN KEY ("generated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_promotion_requests" ADD CONSTRAINT "truth_promotion_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_promotion_requests" ADD CONSTRAINT "truth_promotion_requests_truth_run_id_truth_runs_id_fk" FOREIGN KEY ("truth_run_id") REFERENCES "public"."truth_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_promotion_requests" ADD CONSTRAINT "truth_promotion_requests_brief_id_truth_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."truth_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_promotion_requests" ADD CONSTRAINT "truth_promotion_requests_dossier_id_truth_dossiers_id_fk" FOREIGN KEY ("dossier_id") REFERENCES "public"."truth_dossiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_run_audits" ADD CONSTRAINT "truth_run_audits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_run_audits" ADD CONSTRAINT "truth_run_audits_truth_run_id_truth_runs_id_fk" FOREIGN KEY ("truth_run_id") REFERENCES "public"."truth_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_runs" ADD CONSTRAINT "truth_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truth_runs" ADD CONSTRAINT "truth_runs_truth_document_id_truth_documents_id_fk" FOREIGN KEY ("truth_document_id") REFERENCES "public"."truth_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "truth_atoms_company_document_idx" ON "truth_atoms" USING btree ("company_id","truth_document_id");--> statement-breakpoint
CREATE INDEX "truth_atoms_company_run_idx" ON "truth_atoms" USING btree ("company_id","truth_run_id");--> statement-breakpoint
CREATE INDEX "truth_briefs_company_run_idx" ON "truth_briefs" USING btree ("company_id","truth_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "truth_document_chunks_company_source_key_uq" ON "truth_document_chunks" USING btree ("company_id","source_chunk_key");--> statement-breakpoint
CREATE UNIQUE INDEX "truth_document_chunks_company_deterministic_key_uq" ON "truth_document_chunks" USING btree ("company_id","deterministic_key");--> statement-breakpoint
CREATE INDEX "truth_document_chunks_company_document_idx" ON "truth_document_chunks" USING btree ("company_id","truth_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "truth_documents_company_source_sha_uq" ON "truth_documents" USING btree ("company_id","source_sha256");--> statement-breakpoint
CREATE INDEX "truth_documents_company_ingest_status_idx" ON "truth_documents" USING btree ("company_id","ingest_status");--> statement-breakpoint
CREATE INDEX "truth_documents_company_embedding_status_idx" ON "truth_documents" USING btree ("company_id","embedding_status");--> statement-breakpoint
CREATE INDEX "truth_documents_slug_mapping_confidence_idx" ON "truth_documents" USING btree ("company_slug","mapping_confidence");--> statement-breakpoint
CREATE INDEX "truth_dossiers_company_run_idx" ON "truth_dossiers" USING btree ("company_id","truth_run_id");--> statement-breakpoint
CREATE INDEX "truth_promotion_requests_company_status_idx" ON "truth_promotion_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "truth_run_audits_company_run_idx" ON "truth_run_audits" USING btree ("company_id","truth_run_id");--> statement-breakpoint
CREATE INDEX "truth_runs_company_document_idx" ON "truth_runs" USING btree ("company_id","truth_document_id");