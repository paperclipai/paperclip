CREATE TABLE "automatic_run_brakes" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"reason" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"next_probe_at" timestamp with time zone,
	"probe_run_id" uuid,
	"probe_successes" integer DEFAULT 0 NOT NULL,
	"release_window_started_at" timestamp with time zone,
	"release_window_starts" integer DEFAULT 0 NOT NULL,
	"next_creation_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automatic_run_brakes" ADD CONSTRAINT "automatic_run_brakes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;