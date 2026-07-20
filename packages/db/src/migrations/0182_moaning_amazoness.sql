CREATE TABLE "company_secret_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_name" text,
	"proposed_key" text,
	"proposed_description" text,
	"justification" text NOT NULL,
	"value_ciphertext" jsonb,
	"value_fingerprint_sha256" text,
	"value_length" integer,
	"secret_id" uuid,
	"secret_proposal_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"config_path" text,
	"projection_class" text DEFAULT 'unclassified' NOT NULL,
	"binding_target_policy_snapshot" text,
	"proposer_ancestor_ids_snapshot" jsonb,
	"target_ancestor_ids_snapshot" jsonb,
	"proposed_by_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid,
	"origin_run_id" uuid NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"created_secret_id" uuid,
	"applied_binding_config_path" text,
	"ciphertext_scrubbed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_secret_proposals_kind_check" CHECK ("kind" in ('secret', 'binding')),
	CONSTRAINT "company_secret_proposals_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
	CONSTRAINT "company_secret_proposals_projection_check" CHECK ("projection_class" = 'unclassified'),
	CONSTRAINT "company_secret_proposals_shape_check" CHECK (("kind" = 'secret' and "proposed_name" is not null and "proposed_key" is not null and "secret_id" is null and "secret_proposal_id" is null and "target_type" is null and "target_id" is null and "config_path" is null) or ("kind" = 'binding' and (("secret_id" is not null)::int + ("secret_proposal_id" is not null)::int) = 1 and "target_type" = 'agent' and "target_id" is not null and "config_path" is not null))
);
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "company_secrets"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_secret_proposal_id_company_secret_proposals_id_fk" FOREIGN KEY ("secret_proposal_id") REFERENCES "company_secret_proposals"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_target_id_agents_id_fk" FOREIGN KEY ("target_id") REFERENCES "agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "issues"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_created_secret_id_company_secrets_id_fk" FOREIGN KEY ("created_secret_id") REFERENCES "company_secrets"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "company_secret_proposals_company_status_idx" ON "company_secret_proposals" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX "company_secret_proposals_proposer_status_idx" ON "company_secret_proposals" ("proposed_by_agent_id", "status");
--> statement-breakpoint
CREATE INDEX "company_secret_proposals_expiry_idx" ON "company_secret_proposals" ("status", "expires_at");
--> statement-breakpoint
CREATE INDEX "company_secret_proposals_secret_proposal_idx" ON "company_secret_proposals" ("secret_proposal_id");
