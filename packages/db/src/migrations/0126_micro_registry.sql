CREATE TABLE IF NOT EXISTS "micro_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "paperclip_issue_id" uuid,
  "identifier" text NOT NULL,
  "title" text NOT NULL,
  "source" text NOT NULL,
  "thesis" text NOT NULL,
  "owner_agent_id" uuid,
  "lifecycle_state" text DEFAULT 'draft' NOT NULL,
  "improvement_attempt_count" integer DEFAULT 0 NOT NULL,
  "dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "compute_assignment_id" uuid,
  "data_assignment_id" uuid,
  "broker_assignment_id" uuid,
  "evidence_pack_id" uuid,
  "promotion_request_id" uuid,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_experiments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "pod_id" uuid NOT NULL,
  "paperclip_issue_id" uuid,
  "identifier" text NOT NULL,
  "title" text NOT NULL,
  "hypothesis" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_url" text,
  "lifecycle_state" text DEFAULT 'draft' NOT NULL,
  "max_improvement_attempts" integer DEFAULT 5 NOT NULL,
  "improvement_attempt_count" integer DEFAULT 0 NOT NULL,
  "overnight_allowed" boolean DEFAULT false NOT NULL,
  "holding_period_min_minutes" integer DEFAULT 1 NOT NULL,
  "holding_period_max_minutes" integer,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "verdict" text,
  "verdict_reason" text,
  "evidence_pack_id" uuid,
  "promotion_request_id" uuid,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_dependency_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "pod_id" uuid,
  "experiment_id" uuid,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'open' NOT NULL,
  "routed_to_agent_id" uuid,
  "paperclip_issue_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_evidence_packs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "pod_id" uuid,
  "experiment_id" uuid,
  "title" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "artifact_uri" text NOT NULL,
  "summary" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "micro_promotion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "pod_id" uuid,
  "experiment_id" uuid,
  "evidence_pack_id" uuid,
  "target" text NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "rationale" text NOT NULL,
  "risk_notes" text,
  "paperclip_issue_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "micro_pods" ADD CONSTRAINT "micro_pods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_pods" ADD CONSTRAINT "micro_pods_paperclip_issue_id_issues_id_fk" FOREIGN KEY ("paperclip_issue_id") REFERENCES "issues"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_pods" ADD CONSTRAINT "micro_pods_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "agents"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_pods" ADD CONSTRAINT "micro_pods_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_experiments" ADD CONSTRAINT "micro_experiments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_experiments" ADD CONSTRAINT "micro_experiments_pod_id_micro_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "micro_pods"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_experiments" ADD CONSTRAINT "micro_experiments_paperclip_issue_id_issues_id_fk" FOREIGN KEY ("paperclip_issue_id") REFERENCES "issues"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_experiments" ADD CONSTRAINT "micro_experiments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_dependency_requests" ADD CONSTRAINT "micro_dependency_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_dependency_requests" ADD CONSTRAINT "micro_dependency_requests_pod_id_micro_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "micro_pods"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_dependency_requests" ADD CONSTRAINT "micro_dependency_requests_experiment_id_micro_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "micro_experiments"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_dependency_requests" ADD CONSTRAINT "micro_dependency_requests_routed_to_agent_id_agents_id_fk" FOREIGN KEY ("routed_to_agent_id") REFERENCES "agents"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_dependency_requests" ADD CONSTRAINT "micro_dependency_requests_paperclip_issue_id_issues_id_fk" FOREIGN KEY ("paperclip_issue_id") REFERENCES "issues"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_evidence_packs" ADD CONSTRAINT "micro_evidence_packs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_evidence_packs" ADD CONSTRAINT "micro_evidence_packs_pod_id_micro_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "micro_pods"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_evidence_packs" ADD CONSTRAINT "micro_evidence_packs_experiment_id_micro_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "micro_experiments"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_promotion_requests" ADD CONSTRAINT "micro_promotion_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_promotion_requests" ADD CONSTRAINT "micro_promotion_requests_pod_id_micro_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "micro_pods"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_promotion_requests" ADD CONSTRAINT "micro_promotion_requests_experiment_id_micro_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "micro_experiments"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "micro_promotion_requests" ADD CONSTRAINT "micro_promotion_requests_evidence_pack_id_micro_evidence_packs_id_fk" FOREIGN KEY ("evidence_pack_id") REFERENCES "micro_evidence_packs"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "micro_promotion_requests" ADD CONSTRAINT "micro_promotion_requests_paperclip_issue_id_issues_id_fk" FOREIGN KEY ("paperclip_issue_id") REFERENCES "issues"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_pods_company_state_idx" ON "micro_pods" USING btree ("company_id", "lifecycle_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_pods_company_owner_state_idx" ON "micro_pods" USING btree ("company_id", "owner_agent_id", "lifecycle_state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_pods_company_identifier_uq" ON "micro_pods" USING btree ("company_id", "identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_experiments_company_state_idx" ON "micro_experiments" USING btree ("company_id", "lifecycle_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_experiments_company_pod_state_idx" ON "micro_experiments" USING btree ("company_id", "pod_id", "lifecycle_state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "micro_experiments_company_identifier_uq" ON "micro_experiments" USING btree ("company_id", "identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_dependency_requests_company_status_idx" ON "micro_dependency_requests" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_dependency_requests_company_pod_idx" ON "micro_dependency_requests" USING btree ("company_id", "pod_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_evidence_packs_company_status_idx" ON "micro_evidence_packs" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_evidence_packs_company_experiment_idx" ON "micro_evidence_packs" USING btree ("company_id", "experiment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_promotion_requests_company_status_idx" ON "micro_promotion_requests" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "micro_promotion_requests_company_experiment_idx" ON "micro_promotion_requests" USING btree ("company_id", "experiment_id");
