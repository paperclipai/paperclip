CREATE TABLE IF NOT EXISTS "bookforge_approved_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed_stale_check_needed' NOT NULL,
	"yaml" text,
	"item_id" text,
	"project_name" text,
	"book_title" text,
	"budget_cap_cents" integer,
	"quality_threshold" text,
	"resume_allowed" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approval_issue_id" text,
	"approval_comment_id" text,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"mismatch_details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bookforge_approved_targets" ADD CONSTRAINT "bookforge_approved_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookforge_approved_targets_company_status_idx" ON "bookforge_approved_targets" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookforge_approved_targets_company_updated_idx" ON "bookforge_approved_targets" USING btree ("company_id","updated_at");
