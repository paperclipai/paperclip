CREATE TABLE "delivery_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"declaration_revision" integer NOT NULL,
	"target_fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"delivered_revision" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "completion_requirement" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "completion_requirement_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "default_completion_requirement" text;--> statement-breakpoint
ALTER TABLE "delivery_attestations" ADD CONSTRAINT "delivery_attestations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attestations" ADD CONSTRAINT "delivery_attestations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attestations" ADD CONSTRAINT "delivery_attestations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attestations_run_idx" ON "delivery_attestations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "delivery_attestations_issue_outcome_idx" ON "delivery_attestations" USING btree ("company_id","issue_id","outcome","created_at");