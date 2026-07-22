CREATE TABLE IF NOT EXISTS "board_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"command" text NOT NULL,
	"client_name" text,
	"requested_access" text DEFAULT 'board' NOT NULL,
	"requested_company_id" uuid,
	"pending_key_hash" text NOT NULL,
	"pending_key_name" text NOT NULL,
	"approved_by_user_id" text,
	"board_api_key_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "general" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_api_keys_user_id_user_id_fk') THEN
  ALTER TABLE "board_api_keys" ADD CONSTRAINT "board_api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_challenges_requested_company_id_companies_id_fk') THEN
  ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_requested_company_id_companies_id_fk" FOREIGN KEY ("requested_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_challenges_approved_by_user_id_user_id_fk') THEN
  ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_challenges_board_api_key_id_board_api_keys_id_fk') THEN
  ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "board_api_keys_key_hash_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_api_keys_user_idx" ON "board_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cli_auth_challenges_secret_hash_idx" ON "cli_auth_challenges" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cli_auth_challenges_approved_by_idx" ON "cli_auth_challenges" USING btree ("approved_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cli_auth_challenges_requested_company_idx" ON "cli_auth_challenges" USING btree ("requested_company_id");
