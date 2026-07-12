ALTER TABLE "routines" ADD COLUMN "evolution_mode" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
CREATE TABLE "routine_evolution_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"base_revision_number" integer NOT NULL,
	"proposed_title" text,
	"proposed_description" text NOT NULL,
	"change_summary" text NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"applied_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_evolution_proposals" ADD CONSTRAINT "routine_evolution_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_evolution_proposals" ADD CONSTRAINT "routine_evolution_proposals_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_evolution_proposals" ADD CONSTRAINT "routine_evolution_proposals_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_evolution_proposals" ADD CONSTRAINT "routine_evolution_proposals_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_evolution_proposals" ADD CONSTRAINT "routine_evolution_proposals_applied_revision_id_routine_revisions_id_fk" FOREIGN KEY ("applied_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "routine_evolution_proposals_company_routine_status_idx" ON "routine_evolution_proposals" USING btree ("company_id","routine_id","status");
