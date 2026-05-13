-- CLO-672: releaseEvidence closure gate
-- Stores the evidence supplied at close time on code-touching issues,
-- plus an immutable audit log of every validator outcome.

ALTER TABLE "issues"
	ADD COLUMN IF NOT EXISTS "release_evidence" jsonb;
--> statement-breakpoint

ALTER TABLE "issues"
	ADD COLUMN IF NOT EXISTS "release_evidence_validated_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "issues"
	ADD COLUMN IF NOT EXISTS "release_evidence_validation_error" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "release_evidence_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid,
	"actor_user_id" text,
	"kind" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"github_api_called" boolean DEFAULT false NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_evidence_audit_log_outcome_check"
		CHECK ("outcome" IN ('accepted','rejected'))
);
--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'release_evidence_audit_log_issue_id_issues_id_fk'
	) THEN
		ALTER TABLE "release_evidence_audit_log"
			ADD CONSTRAINT "release_evidence_audit_log_issue_id_issues_id_fk"
			FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'release_evidence_audit_log_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "release_evidence_audit_log"
			ADD CONSTRAINT "release_evidence_audit_log_agent_id_agents_id_fk"
			FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
			ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "release_evidence_audit_log_issue_idx"
	ON "release_evidence_audit_log" ("issue_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "release_evidence_audit_log_created_at_idx"
	ON "release_evidence_audit_log" ("created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "release_evidence_audit_log_outcome_idx"
	ON "release_evidence_audit_log" ("outcome", "created_at");
