CREATE TABLE "delivery_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"verdict_id" uuid,
	"plan_revision_id" uuid,
	"candidate_head_sha" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_by_user_id" text NOT NULL,
	"accepted_by_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"plan_revision_id" uuid,
	"repository_url" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"submitted_by_agent_id" uuid,
	"submitted_by_user_id" text,
	"submitted_by_run_id" uuid,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid,
	"repository_url" text,
	"require_review" boolean DEFAULT false NOT NULL,
	"require_verified_evidence" boolean DEFAULT false NOT NULL,
	"pin_plan_revision" boolean DEFAULT false NOT NULL,
	"reviewer_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"enrolled_by_agent_id" uuid,
	"enrolled_by_user_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"plan_revision_id" uuid,
	"candidate_head_sha" text NOT NULL,
	"verdict" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer_agent_id" uuid,
	"reviewer_user_id" text,
	"reviewer_run_id" uuid,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_verification_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"plan_revision_id" uuid,
	"candidate_head_sha" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"producer_label" text NOT NULL,
	"produced_by_user_id" text,
	"produced_by_session_id" text,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_acceptances" ADD CONSTRAINT "delivery_acceptances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_acceptances" ADD CONSTRAINT "delivery_acceptances_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_acceptances" ADD CONSTRAINT "delivery_acceptances_submission_id_delivery_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."delivery_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_acceptances" ADD CONSTRAINT "delivery_acceptances_verdict_id_delivery_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."delivery_verdicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_acceptances" ADD CONSTRAINT "delivery_acceptances_plan_revision_id_document_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_submissions" ADD CONSTRAINT "delivery_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_submissions" ADD CONSTRAINT "delivery_submissions_track_id_delivery_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."delivery_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_submissions" ADD CONSTRAINT "delivery_submissions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_submissions" ADD CONSTRAINT "delivery_submissions_plan_revision_id_document_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_submissions" ADD CONSTRAINT "delivery_submissions_submitted_by_agent_id_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_submissions" ADD CONSTRAINT "delivery_submissions_submitted_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("submitted_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tracks" ADD CONSTRAINT "delivery_tracks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tracks" ADD CONSTRAINT "delivery_tracks_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tracks" ADD CONSTRAINT "delivery_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tracks" ADD CONSTRAINT "delivery_tracks_enrolled_by_agent_id_agents_id_fk" FOREIGN KEY ("enrolled_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verdicts" ADD CONSTRAINT "delivery_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verdicts" ADD CONSTRAINT "delivery_verdicts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verdicts" ADD CONSTRAINT "delivery_verdicts_submission_id_delivery_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."delivery_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verdicts" ADD CONSTRAINT "delivery_verdicts_plan_revision_id_document_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verdicts" ADD CONSTRAINT "delivery_verdicts_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verdicts" ADD CONSTRAINT "delivery_verdicts_reviewer_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("reviewer_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verification_evidence" ADD CONSTRAINT "delivery_verification_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verification_evidence" ADD CONSTRAINT "delivery_verification_evidence_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_verification_evidence" ADD CONSTRAINT "delivery_verification_evidence_plan_revision_id_document_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_acceptances_candidate_uq" ON "delivery_acceptances" USING btree ("company_id","issue_id","candidate_head_sha");--> statement-breakpoint
CREATE INDEX "delivery_acceptances_company_issue_created_idx" ON "delivery_acceptances" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_submissions_candidate_uq" ON "delivery_submissions" USING btree ("company_id","issue_id","head_sha");--> statement-breakpoint
CREATE INDEX "delivery_submissions_company_issue_created_idx" ON "delivery_submissions" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_submissions_track_idx" ON "delivery_submissions" USING btree ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_tracks_issue_uq" ON "delivery_tracks" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "delivery_tracks_company_status_idx" ON "delivery_tracks" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_verdicts_reviewer_run_uq" ON "delivery_verdicts" USING btree ("company_id","submission_id","reviewer_agent_id","reviewer_run_id");--> statement-breakpoint
CREATE INDEX "delivery_verdicts_company_issue_created_idx" ON "delivery_verdicts" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_verdicts_submission_idx" ON "delivery_verdicts" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_verification_evidence_digest_uq" ON "delivery_verification_evidence" USING btree ("company_id","issue_id","digest");--> statement-breakpoint
CREATE INDEX "delivery_verification_evidence_candidate_idx" ON "delivery_verification_evidence" USING btree ("company_id","issue_id","candidate_head_sha");