CREATE TABLE IF NOT EXISTS "ai_provider_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"grant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_defaults_provider_check" CHECK ("ai_provider_defaults"."provider" in ('anthropic','openai','openrouter','xai'))
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_defaults_owner_provider_uq" ON "ai_provider_defaults" USING btree ("company_id","user_id","provider");
--> statement-breakpoint
-- Old servers write only the per-method table. INSERT means first account for
-- that method; UPDATE means an explicit Make default action. Preserve that
-- distinction so adding an account never replaces an unavailable default.
CREATE OR REPLACE FUNCTION sync_ai_provider_default() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ai_provider_defaults (company_id, user_id, provider, grant_id, updated_at)
    VALUES (NEW.company_id, NEW.user_id, NEW.provider, NEW.grant_id, NEW.updated_at)
    ON CONFLICT (company_id, user_id, provider) DO NOTHING;
  ELSE
    INSERT INTO ai_provider_defaults (company_id, user_id, provider, grant_id, updated_at)
    VALUES (NEW.company_id, NEW.user_id, NEW.provider, NEW.grant_id, NEW.updated_at)
    ON CONFLICT (company_id, user_id, provider) DO UPDATE
    SET grant_id = EXCLUDED.grant_id, updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER ai_connection_defaults_sync_provider
AFTER INSERT OR UPDATE OF grant_id, updated_at ON ai_connection_defaults
FOR EACH ROW EXECUTE FUNCTION sync_ai_provider_default();
--> statement-breakpoint
-- Install the trigger before reading legacy rows; its table lock holds until
-- this migration commits, so an old-server write cannot miss synchronization.
-- Preserve all legacy preferences. The most recently updated method default
-- becomes the initial provider default, even when unavailable. Never use health
-- to silently replace a revoked or missing credential.
INSERT INTO ai_provider_defaults (company_id, user_id, provider, grant_id, updated_at)
SELECT DISTINCT ON (company_id, user_id, provider)
  company_id, user_id, provider, grant_id, updated_at
FROM ai_connection_defaults
ORDER BY company_id, user_id, provider, updated_at DESC, id DESC
ON CONFLICT (company_id, user_id, provider) DO NOTHING;
