-- Better Auth two-factor (TOTP + backup codes) support.
--
-- Adds the per-account opt-in flag on `user` and the `two_factor` table that
-- the Better Auth `twoFactor` plugin reads/writes. Both are guarded so the
-- migration is safe to replay on an instance that already applied an earlier
-- copy under a different number (preview instances).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
