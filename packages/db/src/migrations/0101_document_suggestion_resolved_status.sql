-- First-class `resolved` suggestion status (PAP-10574). "Resolved" = handled
-- outside review / no longer applies, distinct from "rejected" (disagreement).
-- `status` is a plain text column with no enum/check constraint, so the new
-- value needs no constraint change — only the audit columns below.
ALTER TABLE "document_suggestions" ADD COLUMN IF NOT EXISTS "resolved_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD COLUMN IF NOT EXISTS "resolved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
