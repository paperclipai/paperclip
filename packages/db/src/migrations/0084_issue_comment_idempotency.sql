ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
-- Historical comments cannot be safely backfilled here. The live key includes
-- the raw pre-redaction body plus actor/run context, while stored rows may
-- already contain redacted text. Writing guessed keys would silently miss
-- future retries or collide unrelated comments, so this migration enables
-- forward idempotency without mutating ambiguous existing rows.
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_idempotency_key_uq"
  ON "issue_comments" USING btree ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
