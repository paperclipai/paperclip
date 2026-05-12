ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "is_ceo_chat" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_company_ceo_chat_uq"
  ON "issues" USING btree ("company_id")
  WHERE "is_ceo_chat" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_is_ceo_chat_idx"
  ON "issues" USING btree ("company_id", "is_ceo_chat");
