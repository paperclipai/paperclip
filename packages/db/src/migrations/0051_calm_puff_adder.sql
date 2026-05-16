CREATE TABLE "standup_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"linked_comment_id" uuid,
	"service_run_id" uuid,
	"canonical_key" text NOT NULL,
	"source_blocker_key" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"proof_target" text NOT NULL,
	"timing_state" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"action_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"outbox_job_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"last_error" text,
	"payload_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"replay_receipt" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"acting_owner_agent_id" uuid NOT NULL,
	"escalation_issue_id" uuid,
	"service_run_id" uuid,
	"canonical_key" text NOT NULL,
	"reason" text NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"closure_condition" text NOT NULL,
	"delivery_proof_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid,
	"action_id" uuid,
	"escalation_id" uuid,
	"service_run_id" uuid,
	"job_type" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"last_error" text,
	"replay_of_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"directive_issue_id" uuid,
	"response_status" text DEFAULT 'pending' NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"escalation_due_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_key" text NOT NULL,
	"standup_type" text DEFAULT 'daily' NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"schedule_cron" text NOT NULL,
	"recovery_by_local_time" text NOT NULL,
	"response_due_local_time" text NOT NULL,
	"escalation_due_local_time" text NOT NULL,
	"participant_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generic_answer_denylist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"non_green_trigger_rule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_routing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disable_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_routine_id" uuid,
	"service_run_id" uuid,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"actor_agent_id" uuid NOT NULL,
	"actor_run_id" uuid,
	"response_json" jsonb NOT NULL,
	"valid" boolean DEFAULT false NOT NULL,
	"rejected_reason" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standup_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"routine_id" uuid,
	"trigger_id" uuid,
	"routine_run_id" uuid,
	"service_run_id" uuid,
	"standup_issue_id" uuid,
	"local_date" text NOT NULL,
	"standup_type" text DEFAULT 'daily' NOT NULL,
	"policy_version" integer NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger_source" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_condition_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assessment_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manual_trigger_receipt" jsonb,
	"partial_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"escalation_due_at" timestamp with time zone NOT NULL,
	"action_due_at" timestamp with time zone,
	"fired_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standup_actions" ADD CONSTRAINT "standup_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_actions" ADD CONSTRAINT "standup_actions_session_id_standup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."standup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_actions" ADD CONSTRAINT "standup_actions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_actions" ADD CONSTRAINT "standup_actions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_actions" ADD CONSTRAINT "standup_actions_linked_comment_id_issue_comments_id_fk" FOREIGN KEY ("linked_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_actions" ADD CONSTRAINT "standup_actions_service_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("service_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_dead_letters" ADD CONSTRAINT "standup_dead_letters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_dead_letters" ADD CONSTRAINT "standup_dead_letters_session_id_standup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."standup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_dead_letters" ADD CONSTRAINT "standup_dead_letters_outbox_job_id_standup_outbox_jobs_id_fk" FOREIGN KEY ("outbox_job_id") REFERENCES "public"."standup_outbox_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_session_id_standup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."standup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_participant_id_standup_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."standup_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_acting_owner_agent_id_agents_id_fk" FOREIGN KEY ("acting_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_escalation_issue_id_issues_id_fk" FOREIGN KEY ("escalation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_escalations" ADD CONSTRAINT "standup_escalations_service_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("service_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_session_id_standup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."standup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_participant_id_standup_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."standup_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_action_id_standup_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."standup_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_escalation_id_standup_escalations_id_fk" FOREIGN KEY ("escalation_id") REFERENCES "public"."standup_escalations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_service_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("service_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_outbox_jobs" ADD CONSTRAINT "standup_outbox_jobs_replay_of_job_id_standup_outbox_jobs_id_fk" FOREIGN KEY ("replay_of_job_id") REFERENCES "public"."standup_outbox_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_participants" ADD CONSTRAINT "standup_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_participants" ADD CONSTRAINT "standup_participants_session_id_standup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."standup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_participants" ADD CONSTRAINT "standup_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_participants" ADD CONSTRAINT "standup_participants_directive_issue_id_issues_id_fk" FOREIGN KEY ("directive_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_policies" ADD CONSTRAINT "standup_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_policies" ADD CONSTRAINT "standup_policies_linked_routine_id_routines_id_fk" FOREIGN KEY ("linked_routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_policies" ADD CONSTRAINT "standup_policies_service_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("service_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_responses" ADD CONSTRAINT "standup_responses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_responses" ADD CONSTRAINT "standup_responses_session_id_standup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."standup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_responses" ADD CONSTRAINT "standup_responses_participant_id_standup_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."standup_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_responses" ADD CONSTRAINT "standup_responses_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_responses" ADD CONSTRAINT "standup_responses_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_policy_id_standup_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."standup_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_service_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("service_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standup_sessions" ADD CONSTRAINT "standup_sessions_standup_issue_id_issues_id_fk" FOREIGN KEY ("standup_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standup_actions_company_canonical_key_uq" ON "standup_actions" USING btree ("company_id","canonical_key");--> statement-breakpoint
CREATE INDEX "standup_actions_session_idx" ON "standup_actions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "standup_actions_owner_due_idx" ON "standup_actions" USING btree ("company_id","owner_agent_id","due_at");--> statement-breakpoint
CREATE INDEX "standup_actions_issue_idx" ON "standup_actions" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "standup_dead_letters_outbox_job_uq" ON "standup_dead_letters" USING btree ("outbox_job_id");--> statement-breakpoint
CREATE INDEX "standup_dead_letters_company_session_idx" ON "standup_dead_letters" USING btree ("company_id","session_id");--> statement-breakpoint
CREATE INDEX "standup_dead_letters_unresolved_idx" ON "standup_dead_letters" USING btree ("company_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "standup_escalations_company_canonical_key_uq" ON "standup_escalations" USING btree ("company_id","canonical_key");--> statement-breakpoint
CREATE INDEX "standup_escalations_session_participant_idx" ON "standup_escalations" USING btree ("session_id","participant_id");--> statement-breakpoint
CREATE INDEX "standup_escalations_deadline_idx" ON "standup_escalations" USING btree ("company_id","status","deadline_at");--> statement-breakpoint
CREATE INDEX "standup_escalations_issue_idx" ON "standup_escalations" USING btree ("escalation_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "standup_outbox_jobs_company_idempotency_uq" ON "standup_outbox_jobs" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "standup_outbox_jobs_retry_scan_idx" ON "standup_outbox_jobs" USING btree ("status","next_attempt_at","priority","created_at");--> statement-breakpoint
CREATE INDEX "standup_outbox_jobs_deadline_priority_idx" ON "standup_outbox_jobs" USING btree ("company_id","session_id","priority","next_attempt_at");--> statement-breakpoint
CREATE INDEX "standup_outbox_jobs_dead_letter_scan_idx" ON "standup_outbox_jobs" USING btree ("company_id","status","dead_lettered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "standup_participants_session_agent_uq" ON "standup_participants" USING btree ("session_id","agent_id");--> statement-breakpoint
CREATE INDEX "standup_participants_company_deadline_idx" ON "standup_participants" USING btree ("company_id","response_status","response_due_at","escalation_due_at");--> statement-breakpoint
CREATE INDEX "standup_participants_directive_issue_idx" ON "standup_participants" USING btree ("directive_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "standup_policies_company_key_uq" ON "standup_policies" USING btree ("company_id","policy_key");--> statement-breakpoint
CREATE INDEX "standup_policies_company_status_idx" ON "standup_policies" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "standup_policies_linked_routine_idx" ON "standup_policies" USING btree ("linked_routine_id");--> statement-breakpoint
CREATE INDEX "standup_responses_participant_idx" ON "standup_responses" USING btree ("participant_id","submitted_at");--> statement-breakpoint
CREATE INDEX "standup_responses_actor_run_idx" ON "standup_responses" USING btree ("actor_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "standup_responses_accepted_participant_uq" ON "standup_responses" USING btree ("participant_id") WHERE "standup_responses"."valid" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "standup_sessions_company_date_type_uq" ON "standup_sessions" USING btree ("company_id","local_date","standup_type");--> statement-breakpoint
CREATE INDEX "standup_sessions_policy_date_idx" ON "standup_sessions" USING btree ("policy_id","local_date");--> statement-breakpoint
CREATE INDEX "standup_sessions_routine_run_idx" ON "standup_sessions" USING btree ("routine_run_id");--> statement-breakpoint
CREATE INDEX "standup_sessions_due_idx" ON "standup_sessions" USING btree ("company_id","status","response_due_at","escalation_due_at");