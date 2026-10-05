ALTER TABLE "routines" ADD COLUMN "consecutive_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "failure_circuit_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "failure_escalation_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_failure_escalation_issue_id_issues_id_fk" FOREIGN KEY ("failure_escalation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;