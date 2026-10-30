CREATE TABLE IF NOT EXISTS "run_identity_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"responsible_user_id" text,
	"message_id" uuid,
	"parent_context_id" uuid,
	"cause" text NOT NULL,
	"correlation_id" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"accepted_at" timestamp with time zone,
	"github" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "active_identity_context_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_identity_contexts_company_id_companies_id_fk' AND conrelid = 'public.run_identity_contexts'::regclass) THEN
  ALTER TABLE "run_identity_contexts" ADD CONSTRAINT "run_identity_contexts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_identity_contexts_run_revision_idx" ON "run_identity_contexts" USING btree ("run_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_identity_contexts_run_correlation_idx" ON "run_identity_contexts" USING btree ("run_id","correlation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_identity_contexts_company_run_idx" ON "run_identity_contexts" USING btree ("company_id","run_id");
