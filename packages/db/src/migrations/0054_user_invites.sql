-- User invites table for the invite flow (Phase 2)
CREATE TABLE IF NOT EXISTS "user_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "token_hash" text NOT NULL,
  "invited_by_user_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "tos_accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_invites_token_hash_unique_idx" ON "user_invites" ("token_hash");
CREATE INDEX IF NOT EXISTS "user_invites_company_email_idx" ON "user_invites" ("company_id", "email");
CREATE INDEX IF NOT EXISTS "user_invites_expires_at_idx" ON "user_invites" ("expires_at");
