ALTER TABLE "board_api_keys" ADD COLUMN IF NOT EXISTS "scope_config" jsonb;--> statement-breakpoint
ALTER TABLE "board_api_keys" ADD COLUMN IF NOT EXISTS "token_prefix" text;--> statement-breakpoint
ALTER TABLE "board_api_keys" ADD COLUMN IF NOT EXISTS "legacy_unrestricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Only rows present before this migration can enter the legacy-unrestricted state.
-- Malformed non-null scope JSON is deliberately preserved so authentication fails closed.
UPDATE "board_api_keys"
SET "legacy_unrestricted" = true
WHERE "scope_config" IS NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'board_api_keys_scope_legacy_check'
      AND conrelid = 'board_api_keys'::regclass
  ) THEN
    ALTER TABLE "board_api_keys"
    ADD CONSTRAINT "board_api_keys_scope_legacy_check"
    CHECK (
      ("legacy_unrestricted" = true AND "scope_config" IS NULL)
      OR
      ("legacy_unrestricted" = false AND "scope_config" IS NOT NULL)
    );
  END IF;
END $$;--> statement-breakpoint

-- Pending CLI auth challenges created before this migration remain nullable and
-- cannot mint a key; every new challenge must persist a validated scope.
ALTER TABLE "cli_auth_challenges" ADD COLUMN IF NOT EXISTS "requested_scope_config" jsonb;
--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD COLUMN IF NOT EXISTS "pending_key_prefix" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "board_api_key_authorization_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "board_api_key_id" uuid NOT NULL,
  "owner_user_id" text NOT NULL,
  "token_prefix" text,
  "action" text NOT NULL,
  "classification" text NOT NULL,
  "authoritative_company_id" uuid,
  "authoritative_resource_type" text,
  "authoritative_resource_id" text,
  "decision" text NOT NULL,
  "reason" text NOT NULL,
  "request_id" text,
  "run_id" uuid,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_api_key_authorization_events_key_created_idx"
ON "board_api_key_authorization_events" USING btree ("board_api_key_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_api_key_authorization_events_company_created_idx"
ON "board_api_key_authorization_events" USING btree ("authoritative_company_id", "created_at" DESC);
