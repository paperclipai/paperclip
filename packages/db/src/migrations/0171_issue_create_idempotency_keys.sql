CREATE TABLE IF NOT EXISTS "issue_create_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_create_idempotency_keys_company_key_uq"
  ON "issue_create_idempotency_keys" USING btree ("company_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_create_idempotency_keys_issue_idx"
  ON "issue_create_idempotency_keys" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_open_normalized_title_created_idx"
  ON "issues" USING btree (
    "company_id",
    "parent_id",
    lower(regexp_replace(btrim("title"), '\s+', ' ', 'g')),
    "created_at"
  )
  WHERE "hidden_at" is null and "status" not in ('done', 'cancelled');
