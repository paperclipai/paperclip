ALTER TABLE "issues" ADD COLUMN "delivery_kind" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "delivery_disposition" jsonb;--> statement-breakpoint
CREATE TABLE "delivery_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"host" text DEFAULT 'github.com' NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"github_repository_id" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"connection_id" uuid,
	"verified_at" timestamp with time zone,
	"rename_verified_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_repositories_provider_check" CHECK ("delivery_repositories"."provider" = 'github')
);
--> statement-breakpoint
CREATE TABLE "delivery_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"repository_id" uuid NOT NULL,
	"primary_issue_id" uuid NOT NULL,
	"target_branch" text NOT NULL,
	"source_branch" text NOT NULL,
	"base_sha" text,
	"head_sha" text,
	"accepted_head_sha" text,
	"merged_sha" text,
	"merge_commit_sha" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"artifact_ready" boolean DEFAULT false NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"merge_method" text DEFAULT 'squash' NOT NULL,
	"owner_agent_id" uuid,
	"priority" text DEFAULT 'medium' NOT NULL,
	"blocker" jsonb,
	"next_action" text,
	"next_action_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"queue_entered_at" timestamp with time zone,
	"merge_requested_at" timestamp with time zone,
	"merge_attempt_count" integer DEFAULT 0 NOT NULL,
	"repair_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_units_status_check" CHECK ("delivery_units"."status" in ('submitted','in_review','ready_to_merge','merging','merged','blocked','cancelled','closed_unmerged')),
	CONSTRAINT "delivery_units_merge_method_check" CHECK ("delivery_units"."merge_method" in ('merge','squash','rebase'))
);
--> statement-breakpoint
CREATE TABLE "delivery_unit_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text DEFAULT 'covered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_unit_issues_role_check" CHECK ("delivery_unit_issues"."role" in ('primary','covered'))
);
--> statement-breakpoint
CREATE TABLE "delivery_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"depends_on_unit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by_actor_type" text,
	"created_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_dependencies_kind_check" CHECK ("delivery_dependencies"."kind" in ('needs_artifact','must_merge_after')),
	CONSTRAINT "delivery_dependencies_not_self_check" CHECK ("delivery_dependencies"."unit_id" <> "delivery_dependencies"."depends_on_unit_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"target_branch" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_queue_entries_status_check" CHECK ("delivery_queue_entries"."status" in ('queued','leased','merged','cancelled','blocked'))
);
--> statement-breakpoint
CREATE TABLE "delivery_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid,
	"target_branch" text DEFAULT 'main' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"merge_method" text DEFAULT 'squash' NOT NULL,
	"merge_queue_mode" text DEFAULT 'serialized' NOT NULL,
	"required_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_greptile" boolean DEFAULT false NOT NULL,
	"require_independent_approval" boolean DEFAULT true NOT NULL,
	"github_connection_id" uuid,
	"greptile_connection_id" uuid,
	"auto_deploy_disposition" text DEFAULT 'none' NOT NULL,
	"authorization" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_policies_merge_method_check" CHECK ("delivery_policies"."merge_method" in ('merge','squash','rebase')),
	CONSTRAINT "delivery_policies_merge_queue_mode_check" CHECK ("delivery_policies"."merge_queue_mode" in ('serialized','native_merge_queue')),
	CONSTRAINT "delivery_policies_auto_deploy_disposition_check" CHECK ("delivery_policies"."auto_deploy_disposition" in ('none','block_merge','authorized'))
);
--> statement-breakpoint
CREATE TABLE "delivery_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"source" text DEFAULT 'greptile' NOT NULL,
	"external_id" text NOT NULL,
	"severity" text DEFAULT 'unknown' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"file_path" text,
	"line" integer,
	"url" text,
	"head_sha" text,
	"state" text DEFAULT 'open' NOT NULL,
	"disposition" text,
	"disposition_explanation" text,
	"disposition_actor_type" text,
	"disposition_actor_id" text,
	"disposition_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_findings_state_check" CHECK ("delivery_findings"."state" in ('open','fixed','disputed','already_addressed','stale'))
);
--> statement-breakpoint
CREATE TABLE "delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"issue_id" uuid,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"dedupe_key" text,
	"url" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"github_repository_id" text,
	"target_branch" text NOT NULL,
	"source_branch" text NOT NULL,
	"submitted_head_sha" text NOT NULL,
	"accepted_head_sha" text NOT NULL,
	"base_sha" text,
	"merged_sha" text NOT NULL,
	"merge_commit_sha" text,
	"merge_method" text NOT NULL,
	"squash_or_rebase" boolean DEFAULT false NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_status" text DEFAULT 'unknown' NOT NULL,
	"blocking_findings" integer DEFAULT 0 NOT NULL,
	"provenance" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"unit_id" uuid,
	"classification" text NOT NULL,
	"outcome" text NOT NULL,
	"observed_status" text NOT NULL,
	"provenance" jsonb,
	"disposition" jsonb,
	"note" text,
	"reconciled_by_actor_type" text NOT NULL,
	"reconciled_by_actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"reconciled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_repair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"head_sha" text,
	"owner_agent_id" uuid,
	"wake_request_id" uuid,
	"requested_by_actor_type" text,
	"requested_by_actor_id" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_repair_attempts_status_check" CHECK ("delivery_repair_attempts"."status" in ('requested','dispatched','resolved','exhausted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_repositories_company_github_id_uq" ON "delivery_repositories" USING btree ("company_id","github_repository_id") WHERE "delivery_repositories"."github_repository_id" is not null;--> statement-breakpoint
CREATE INDEX "delivery_units_company_status_idx" ON "delivery_units" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "delivery_units_company_repository_idx" ON "delivery_units" USING btree ("company_id","repository_id","target_branch");--> statement-breakpoint
CREATE INDEX "delivery_units_primary_issue_idx" ON "delivery_units" USING btree ("company_id","primary_issue_id");--> statement-breakpoint
CREATE INDEX "delivery_units_owner_idx" ON "delivery_units" USING btree ("company_id","owner_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_units_repository_pr_uq" ON "delivery_units" USING btree ("repository_id","pr_number") WHERE "delivery_units"."pr_number" is not null;--> statement-breakpoint
CREATE INDEX "delivery_unit_issues_company_issue_idx" ON "delivery_unit_issues" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "delivery_dependencies_depends_on_idx" ON "delivery_dependencies" USING btree ("company_id","depends_on_unit_id");--> statement-breakpoint
CREATE INDEX "delivery_queue_entries_order_idx" ON "delivery_queue_entries" USING btree ("repository_id","target_branch","status","priority","ready_at","enqueued_at");--> statement-breakpoint
CREATE INDEX "delivery_queue_entries_company_idx" ON "delivery_queue_entries" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "delivery_policies_company_idx" ON "delivery_policies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "delivery_findings_unit_state_idx" ON "delivery_findings" USING btree ("company_id","unit_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_events_dedupe_uq" ON "delivery_events" USING btree ("unit_id","dedupe_key") WHERE "delivery_events"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "delivery_events_unit_created_idx" ON "delivery_events" USING btree ("company_id","unit_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_events_issue_created_idx" ON "delivery_events" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_receipts_company_merged_idx" ON "delivery_receipts" USING btree ("company_id","merged_sha");--> statement-breakpoint
CREATE INDEX "delivery_reconciliations_company_issue_idx" ON "delivery_reconciliations" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "delivery_repair_attempts_unit_idx" ON "delivery_repair_attempts" USING btree ("company_id","unit_id","status");--> statement-breakpoint
ALTER TABLE "delivery_repositories" ADD CONSTRAINT "delivery_repositories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_repositories" ADD CONSTRAINT "delivery_repositories_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_repository_id_delivery_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."delivery_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_primary_issue_id_issues_id_fk" FOREIGN KEY ("primary_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_unit_issues" ADD CONSTRAINT "delivery_unit_issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_unit_issues" ADD CONSTRAINT "delivery_unit_issues_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_unit_issues" ADD CONSTRAINT "delivery_unit_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_dependencies" ADD CONSTRAINT "delivery_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_dependencies" ADD CONSTRAINT "delivery_dependencies_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_dependencies" ADD CONSTRAINT "delivery_dependencies_depends_on_unit_id_delivery_units_id_fk" FOREIGN KEY ("depends_on_unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_queue_entries" ADD CONSTRAINT "delivery_queue_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_queue_entries" ADD CONSTRAINT "delivery_queue_entries_repository_id_delivery_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."delivery_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_queue_entries" ADD CONSTRAINT "delivery_queue_entries_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_repository_id_delivery_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."delivery_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_github_connection_id_tool_connections_id_fk" FOREIGN KEY ("github_connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_greptile_connection_id_tool_connections_id_fk" FOREIGN KEY ("greptile_connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_findings" ADD CONSTRAINT "delivery_findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_findings" ADD CONSTRAINT "delivery_findings_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_reconciliations" ADD CONSTRAINT "delivery_reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_reconciliations" ADD CONSTRAINT "delivery_reconciliations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_reconciliations" ADD CONSTRAINT "delivery_reconciliations_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_repair_attempts" ADD CONSTRAINT "delivery_repair_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_repair_attempts" ADD CONSTRAINT "delivery_repair_attempts_unit_id_delivery_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."delivery_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_repair_attempts" ADD CONSTRAINT "delivery_repair_attempts_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_repositories" ADD CONSTRAINT "delivery_repositories_company_owner_name_uq" UNIQUE("company_id","host","owner","name");--> statement-breakpoint
ALTER TABLE "delivery_unit_issues" ADD CONSTRAINT "delivery_unit_issues_unit_issue_uq" UNIQUE("unit_id","issue_id");--> statement-breakpoint
ALTER TABLE "delivery_dependencies" ADD CONSTRAINT "delivery_dependencies_edge_uq" UNIQUE("unit_id","depends_on_unit_id","kind");--> statement-breakpoint
ALTER TABLE "delivery_queue_entries" ADD CONSTRAINT "delivery_queue_entries_unit_uq" UNIQUE("repository_id","target_branch","unit_id");--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_project_uq" UNIQUE("project_id");--> statement-breakpoint
ALTER TABLE "delivery_findings" ADD CONSTRAINT "delivery_findings_external_uq" UNIQUE("unit_id","source","external_id");--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_unit_uq" UNIQUE("unit_id");--> statement-breakpoint
ALTER TABLE "delivery_reconciliations" ADD CONSTRAINT "delivery_reconciliations_idempotency_uq" UNIQUE("company_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "delivery_repair_attempts" ADD CONSTRAINT "delivery_repair_attempts_uq" UNIQUE("unit_id","reason_code","attempt");
