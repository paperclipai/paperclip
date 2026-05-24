-- Migration: add issue_closure_gate_overrides table (UPG-833 §B hook rev 1)
CREATE TABLE "issue_closure_gate_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"override_reason" text NOT NULL,
	"detector_findings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_closure_gate_overrides" ADD CONSTRAINT "issue_closure_gate_overrides_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_closure_gate_overrides" ADD CONSTRAINT "issue_closure_gate_overrides_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_closure_gate_overrides_issue_id" ON "issue_closure_gate_overrides" USING btree ("issue_id");
