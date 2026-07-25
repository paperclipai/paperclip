CREATE TABLE IF NOT EXISTS "decision_training_examples" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "cutoff_at" timestamp with time zone NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "notes_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "decision_outcome" text,
  "snapshot" jsonb NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_training_examples_source_kind_check"
    CHECK ("source_kind" IN ('interaction', 'approval', 'execution_decision'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_training_examples_company_created_at_idx"
  ON "decision_training_examples" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_training_examples_issue_idx"
  ON "decision_training_examples" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_training_examples_source_author_uq"
  ON "decision_training_examples" USING btree ("source_kind", "source_id", "created_by_user_id");
