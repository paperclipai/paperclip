CREATE TABLE IF NOT EXISTS "agent_setup_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"subject_id" text,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"update_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_setup_progress_status_check" CHECK ("agent_setup_progress"."status" in ('waiting', 'in_progress', 'done', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_setup_progress" ADD CONSTRAINT "agent_setup_progress_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_setup_progress_company_idx" ON "agent_setup_progress" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_setup_progress_expires_idx" ON "agent_setup_progress" USING btree ("expires_at");