CREATE TABLE "release_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"commit_sha" text NOT NULL,
	"image_digest" text NOT NULL,
	"signature_bundle_ref" text NOT NULL,
	"signature_bundle_sha256" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"sbom_hash" text NOT NULL,
	"workflow_run_url" text NOT NULL,
	"environment" text NOT NULL,
	"target_host" text NOT NULL,
	"sequence" integer NOT NULL,
	"document_revision_id" text,
	"status" text DEFAULT 'candidate_created' NOT NULL,
	"approval_interaction_id" uuid,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"staged_artifact_asset_id" uuid,
	"staged_artifact_sha256" text,
	"staged_signature_bundle_asset_id" uuid,
	"staged_signature_bundle_sha256" text,
	"staged_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_deploy_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"approval_interaction_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"target_host" text NOT NULL,
	"image_digest" text NOT NULL,
	"environment" text NOT NULL,
	"sequence" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"lease_artifact_asset_id" uuid,
	"lease_signature_bundle_asset_id" uuid,
	"lease_issued_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_candidate_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"authorization_id" uuid,
	"issue_id" uuid,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redacted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_approval_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("approval_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_staged_artifact_asset_id_assets_id_fk" FOREIGN KEY ("staged_artifact_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_staged_signature_bundle_asset_id_assets_id_fk" FOREIGN KEY ("staged_signature_bundle_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_deploy_authorizations" ADD CONSTRAINT "release_deploy_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_deploy_authorizations" ADD CONSTRAINT "release_deploy_authorizations_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_deploy_authorizations" ADD CONSTRAINT "release_deploy_authorizations_approval_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("approval_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_deploy_authorizations" ADD CONSTRAINT "release_deploy_authorizations_lease_artifact_asset_id_assets_id_fk" FOREIGN KEY ("lease_artifact_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_deploy_authorizations" ADD CONSTRAINT "release_deploy_authorizations_lease_signature_bundle_asset_id_assets_id_fk" FOREIGN KEY ("lease_signature_bundle_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidate_audit_events" ADD CONSTRAINT "release_candidate_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidate_audit_events" ADD CONSTRAINT "release_candidate_audit_events_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidate_audit_events" ADD CONSTRAINT "release_candidate_audit_events_authorization_id_release_deploy_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."release_deploy_authorizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidate_audit_events" ADD CONSTRAINT "release_candidate_audit_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "release_candidate_audit_events" ADD CONSTRAINT "release_candidate_audit_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "release_candidates_company_created_idx" ON "release_candidates" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "release_candidates_source_issue_idx" ON "release_candidates" USING btree ("source_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "release_candidates_company_target_sequence_uq" ON "release_candidates" USING btree ("company_id","environment","target_host","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "release_candidates_company_digest_uq" ON "release_candidates" USING btree ("company_id","image_digest");
--> statement-breakpoint
CREATE INDEX "release_candidates_approval_interaction_idx" ON "release_candidates" USING btree ("approval_interaction_id") WHERE "release_candidates"."approval_interaction_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "release_deploy_authorizations_company_candidate_idx" ON "release_deploy_authorizations" USING btree ("company_id","candidate_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "release_deploy_authorizations_candidate_approval_interaction_uq" ON "release_deploy_authorizations" USING btree ("candidate_id","approval_interaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "release_deploy_authorizations_token_hash_uq" ON "release_deploy_authorizations" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "release_candidate_audit_events_candidate_created_idx" ON "release_candidate_audit_events" USING btree ("candidate_id","created_at");
--> statement-breakpoint
CREATE INDEX "release_candidate_audit_events_company_created_idx" ON "release_candidate_audit_events" USING btree ("company_id","created_at");
