CREATE TABLE "execution_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider_family" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"role_capabilities" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrent_attempts" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_profiles_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "execution_profiles_provider_family_check" CHECK ("execution_profiles"."provider_family" in ('anthropic', 'openai', 'meta', 'deepseek')),
	CONSTRAINT "execution_profiles_role_capabilities_check" CHECK (cardinality("execution_profiles"."role_capabilities") between 1 and 4
        and "execution_profiles"."role_capabilities" <@ array['worker', 'advisor', 'reviewer', 'rescuer']::text[]),
	CONSTRAINT "execution_profiles_bounds_check" CHECK ("execution_profiles"."max_concurrent_attempts" > 0 and "execution_profiles"."version" > 0
        and btrim("execution_profiles"."name") <> '' and btrim("execution_profiles"."model") <> '' and btrim("execution_profiles"."effort") <> '')
);
--> statement-breakpoint
CREATE TABLE "route_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"supersedes_decision_id" uuid,
	"revision_kind" text NOT NULL,
	"policy_version" text NOT NULL,
	"task_class" text NOT NULL,
	"effective_task_class" text NOT NULL,
	"facts" jsonb,
	"state" text NOT NULL,
	"worker_profile_id" uuid,
	"worker_agent_id" uuid,
	"worker_provider_family" text,
	"worker_model" text,
	"worker_effort" text,
	"advisor_profile_id" uuid,
	"advisor_agent_id" uuid,
	"advisor_provider_family" text,
	"advisor_model" text,
	"advisor_effort" text,
	"advisor_mode" text DEFAULT 'none' NOT NULL,
	"reviewer_profile_id" uuid,
	"reviewer_agent_id" uuid,
	"reviewer_provider_family" text,
	"reviewer_model" text,
	"reviewer_effort" text,
	"reviewer_fallback_profile_id" uuid,
	"reviewer_fallback_agent_id" uuid,
	"reviewer_fallback_provider_family" text,
	"reviewer_fallback_model" text,
	"reviewer_fallback_effort" text,
	"rescue_profile_id" uuid,
	"rescue_agent_id" uuid,
	"rescue_provider_family" text,
	"rescue_model" text,
	"rescue_effort" text,
	"require_cross_family_review" boolean DEFAULT true NOT NULL,
	"max_attempts" integer NOT NULL,
	"max_wall_clock_minutes" integer NOT NULL,
	"max_cost_cents" integer,
	"reason_codes" text[] DEFAULT '{}' NOT NULL,
	"escalation_reason" text,
	"note" text,
	"created_by_type" text NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_decisions_company_issue_id_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "route_decisions_revision_check" CHECK ("route_decisions"."revision" > 0
        and (("route_decisions"."revision" = 1 and "route_decisions"."supersedes_decision_id" is null)
          or ("route_decisions"."revision" > 1 and "route_decisions"."supersedes_decision_id" is not null))),
	CONSTRAINT "route_decisions_enums_check" CHECK ("route_decisions"."revision_kind" in ('initial', 'escalation', 'fallback', 'override', 'rescue')
        and "route_decisions"."state" in ('routed', 'classification-required', 'no-capable-worker', 'reviewer-family-conflict', 'reviewer-unavailable', 'budget-limited', 'escalation-required')
        and "route_decisions"."advisor_mode" in ('none', 'optional', 'required')
        and "route_decisions"."created_by_type" in ('user', 'agent', 'system')
        and "route_decisions"."reason_codes" <@ array['cross-layer', 'persistent-schema', 'security-sensitive', 'recovery-invariant', 'concurrency-invariant', 'known-reproduction', 'mechanical-cutover', 'review-rejected', 'repeated-failure', 'provider-unavailable', 'budget-limited']::text[]),
	CONSTRAINT "route_decisions_bounds_check" CHECK ("route_decisions"."max_attempts" > 0 and "route_decisions"."max_wall_clock_minutes" > 0
        and ("route_decisions"."max_cost_cents" is null or "route_decisions"."max_cost_cents" >= 0)),
	CONSTRAINT "route_decisions_worker_state_check" CHECK (("route_decisions"."state" <> 'routed' or "route_decisions"."worker_profile_id" is not null)
        and ("route_decisions"."worker_profile_id" is null) = ("route_decisions"."worker_agent_id" is null)
        and ("route_decisions"."reviewer_profile_id" is null) = ("route_decisions"."reviewer_agent_id" is null)
        and ("route_decisions"."reviewer_provider_family" is null or "route_decisions"."reviewer_provider_family" <> "route_decisions"."worker_provider_family")
        and ("route_decisions"."reviewer_agent_id" is null or "route_decisions"."reviewer_agent_id" <> "route_decisions"."worker_agent_id")),
	CONSTRAINT "route_decisions_actor_check" CHECK (("route_decisions"."created_by_type" = 'user' and "route_decisions"."created_by_user_id" is not null and "route_decisions"."created_by_agent_id" is null)
        or ("route_decisions"."created_by_type" = 'agent' and "route_decisions"."created_by_agent_id" is not null and "route_decisions"."created_by_user_id" is null)
        or ("route_decisions"."created_by_type" = 'system' and "route_decisions"."created_by_user_id" is null and "route_decisions"."created_by_agent_id" is null))
);
--> statement-breakpoint
CREATE TABLE "route_pool_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"run_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "route_pool_claims_role_check" CHECK ("route_pool_claims"."role" in ('worker', 'advisor', 'reviewer', 'rescuer')),
	CONSTRAINT "route_pool_claims_release_check" CHECK (("route_pool_claims"."released_at" is null) = ("route_pool_claims"."release_reason" is null)
        and ("route_pool_claims"."released_at" is null or "route_pool_claims"."released_at" >= "route_pool_claims"."claimed_at"))
);
--> statement-breakpoint
CREATE TABLE "route_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_class" text NOT NULL,
	"worker_profile_id" uuid,
	"advisor_profile_id" uuid,
	"advisor_mode" text DEFAULT 'none' NOT NULL,
	"reviewer_profile_id" uuid,
	"reviewer_fallback_profile_id" uuid,
	"review_requirement" text DEFAULT 'always' NOT NULL,
	"reviewer_fallback_policy" text DEFAULT 'fail_closed' NOT NULL,
	"rescue_profile_id" uuid,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"max_wall_clock_minutes" integer DEFAULT 180 NOT NULL,
	"max_cost_cents" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_rules_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "route_rules_task_class_check" CHECK ("route_rules"."task_class" in ('feature_standard', 'feature_critical', 'migration', 'bug_fast', 'bug_invariant', 'security_recovery', 'mechanical')),
	CONSTRAINT "route_rules_enums_check" CHECK ("route_rules"."advisor_mode" in ('none', 'optional', 'required')
        and "route_rules"."review_requirement" in ('always', 'consequential', 'none')
        and "route_rules"."reviewer_fallback_policy" in ('fallback', 'fail_closed')),
	CONSTRAINT "route_rules_bounds_check" CHECK ("route_rules"."max_attempts" > 0 and "route_rules"."max_wall_clock_minutes" > 0
        and ("route_rules"."max_cost_cents" is null or "route_rules"."max_cost_cents" >= 0) and "route_rules"."version" > 0),
	CONSTRAINT "route_rules_coherence_check" CHECK (("route_rules"."advisor_mode" <> 'none' or "route_rules"."advisor_profile_id" is null)
        and ("route_rules"."review_requirement" <> 'none' or ("route_rules"."reviewer_profile_id" is null and "route_rules"."reviewer_fallback_profile_id" is null))
        and ("route_rules"."reviewer_profile_id" is null or "route_rules"."reviewer_profile_id" <> "route_rules"."worker_profile_id")
        and ("route_rules"."reviewer_fallback_profile_id" is null or "route_rules"."reviewer_fallback_profile_id" <> "route_rules"."worker_profile_id")
        and ("route_rules"."reviewer_profile_id" is null or "route_rules"."reviewer_fallback_profile_id" is null or "route_rules"."reviewer_profile_id" <> "route_rules"."reviewer_fallback_profile_id"))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "execution_profiles" ADD CONSTRAINT "execution_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_profiles" ADD CONSTRAINT "execution_profiles_agent_company_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","supersedes_decision_id") REFERENCES "public"."route_decisions"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_worker_profile_fk" FOREIGN KEY ("company_id","worker_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_reviewer_profile_fk" FOREIGN KEY ("company_id","reviewer_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_pool_claims" ADD CONSTRAINT "route_pool_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_pool_claims" ADD CONSTRAINT "route_pool_claims_profile_fk" FOREIGN KEY ("company_id","profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_pool_claims" ADD CONSTRAINT "route_pool_claims_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_pool_claims" ADD CONSTRAINT "route_pool_claims_decision_fk" FOREIGN KEY ("company_id","issue_id","decision_id") REFERENCES "public"."route_decisions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_pool_claims" ADD CONSTRAINT "route_pool_claims_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_rules" ADD CONSTRAINT "route_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_rules" ADD CONSTRAINT "route_rules_worker_profile_fk" FOREIGN KEY ("company_id","worker_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_rules" ADD CONSTRAINT "route_rules_advisor_profile_fk" FOREIGN KEY ("company_id","advisor_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_rules" ADD CONSTRAINT "route_rules_reviewer_profile_fk" FOREIGN KEY ("company_id","reviewer_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_rules" ADD CONSTRAINT "route_rules_reviewer_fallback_profile_fk" FOREIGN KEY ("company_id","reviewer_fallback_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_rules" ADD CONSTRAINT "route_rules_rescue_profile_fk" FOREIGN KEY ("company_id","rescue_profile_id") REFERENCES "public"."execution_profiles"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_profiles_company_name_uq" ON "execution_profiles" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_profiles_company_agent_uq" ON "execution_profiles" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "route_decisions_company_issue_revision_uq" ON "route_decisions" USING btree ("company_id","issue_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "route_pool_claims_active_issue_role_uq" ON "route_pool_claims" USING btree ("company_id","issue_id","role") WHERE "route_pool_claims"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "route_pool_claims_active_writable_issue_uq" ON "route_pool_claims" USING btree ("company_id","issue_id") WHERE "route_pool_claims"."released_at" is null and "route_pool_claims"."role" in ('worker', 'rescuer');--> statement-breakpoint
CREATE INDEX "route_pool_claims_active_profile_idx" ON "route_pool_claims" USING btree ("company_id","profile_id") WHERE "route_pool_claims"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "route_rules_company_task_class_uq" ON "route_rules" USING btree ("company_id","task_class");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_active_route_review_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'route_review'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');