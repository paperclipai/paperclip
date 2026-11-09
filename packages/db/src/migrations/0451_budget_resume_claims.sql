CREATE TABLE "budget_resume_claims" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_source" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"reason" text,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_resume_claims" ADD CONSTRAINT "budget_resume_claims_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_resume_claims" ADD CONSTRAINT "budget_resume_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_resume_claims" ADD CONSTRAINT "budget_resume_claims_incident_id_budget_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."budget_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_resume_claims_pending_idx" ON "budget_resume_claims" USING btree ("company_id","run_id") WHERE "budget_resume_claims"."state" = 'pending';