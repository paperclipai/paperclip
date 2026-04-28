CREATE TABLE "rt2_v33_phase_controls" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"phase_mode" text DEFAULT 'shadow' NOT NULL,
	"auto_apply_after_hours" integer DEFAULT 24 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_phase_controls_phase_mode_check" CHECK ("rt2_v33_phase_controls"."phase_mode" in ('shadow', 'co_pilot', 'auto')),
	CONSTRAINT "rt2_v33_phase_controls_auto_apply_after_hours_check" CHECK ("rt2_v33_phase_controls"."auto_apply_after_hours" between 1 and 168)
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_phase_controls" ADD CONSTRAINT "rt2_v33_phase_controls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_phase_controls" ADD CONSTRAINT "rt2_v33_phase_controls_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
