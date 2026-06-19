-- P2 telemetry foundation — learning schema (WS1).
-- Mirrors services/oracle-dispatcher/migrations/0001_learning.sql column-for-column;
-- P4 (oracle-dispatcher/learning.py) reads these names — do not rename.
--
-- NPI BAN: agent_runs stores HASHES (input_hash / output_hash). Raw prompt/output text
-- is NEVER persisted (enforced by the telemetry emitter shipping in PR2).
--
-- Note on snapshot: drizzle-kit auto-generated additional DROP TABLE statements
-- for tables (agent_memberships, cloud_upstream_*, document_annotation_*,
-- environment*, issue_recovery_actions, etc.) whose schema files were removed
-- pre-0061 without a corresponding snapshot regen (no 0061_snapshot.json exists).
-- Those drops are NOT part of P2 and are trimmed here. 0062_snapshot.json is kept
-- as drizzle generated it so 0063 diffs against a correct baseline.

CREATE TABLE "prompt_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"task_class" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"parent_version" bigint,
	"created_by" text,
	"gemini_verdict" text,
	"human_approver" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_status_check" CHECK ("prompt_versions"."status" IN ('active', 'candidate', 'retired', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"task_class" text NOT NULL,
	"prompt_version_id" bigint,
	"input_hash" text,
	"output_hash" text,
	"outcome" text,
	"user_feedback" integer,
	"latency_ms" integer,
	"tier" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_deltas" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"base_version" bigint NOT NULL,
	"proposed_body" text NOT NULL,
	"rationale" text NOT NULL,
	"sample_run_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"gemini_audit" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_deltas_status_check" CHECK ("prompt_deltas"."status" IN ('proposed', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "outcome_weights" (
	"task_class" text NOT NULL,
	"agent" text NOT NULL,
	"route_tier" text NOT NULL,
	"n_runs" integer DEFAULT 0 NOT NULL,
	"success_rate" double precision DEFAULT 0 NOT NULL,
	"avg_latency_ms" double precision DEFAULT 0 NOT NULL,
	"loan_conversion_rate" double precision DEFAULT 0 NOT NULL,
	"user_fb_score" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_weights_task_class_agent_route_tier_pk" PRIMARY KEY("task_class","agent","route_tier")
);
--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_parent_version_prompt_versions_id_fk" FOREIGN KEY ("parent_version") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_deltas" ADD CONSTRAINT "prompt_deltas_base_version_prompt_versions_id_fk" FOREIGN KEY ("base_version") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompt_versions_one_active" ON "prompt_versions" USING btree ("agent","task_class") WHERE "prompt_versions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompt_versions_one_candidate" ON "prompt_versions" USING btree ("agent","task_class") WHERE "prompt_versions"."status" = 'candidate';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompt_versions_class_version" ON "prompt_versions" USING btree ("agent","task_class","version");--> statement-breakpoint
CREATE INDEX "ix_agent_runs_class_outcome" ON "agent_runs" USING btree ("task_class","outcome");--> statement-breakpoint
CREATE INDEX "ix_agent_runs_prompt_version" ON "agent_runs" USING btree ("prompt_version_id");--> statement-breakpoint
CREATE INDEX "ix_prompt_deltas_base_status" ON "prompt_deltas" USING btree ("base_version","status");
