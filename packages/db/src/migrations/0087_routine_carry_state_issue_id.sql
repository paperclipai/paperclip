ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "carry_state_issue_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_carry_state_issue_id_issues_id_fk') THEN
    ALTER TABLE "routines" ADD CONSTRAINT "routines_carry_state_issue_id_issues_id_fk" FOREIGN KEY ("carry_state_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
