CREATE TABLE "cube_sf_recon_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sf_loan_id" text NOT NULL,
	"sf_loan_number" text NOT NULL,
	"event_type" text NOT NULL,
	"sf_status" text,
	"cube_milestone" text,
	"est_closing_date" timestamp,
	"severity" text NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"state_transition_key" text NOT NULL,
	"slack_msg_id" text,
	"telegram_msg_id" text
);
--> statement-breakpoint
CREATE TABLE "cube_sf_recon_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"status" text NOT NULL,
	"loans_checked_sf" integer,
	"loans_checked_cube" integer,
	"divergence_count" integer,
	"overdue_count" integer,
	"staleness_flag" boolean,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "cube_sf_recon_event" ADD CONSTRAINT "cube_sf_recon_event_run_id_cube_sf_recon_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cube_sf_recon_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cube_sf_recon_run" ADD CONSTRAINT "cube_sf_recon_run_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;