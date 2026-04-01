CREATE TABLE IF NOT EXISTS "company_provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"env_key" text NOT NULL,
	"label" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_provider_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "company_provider_credentials_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_provider_credentials_company_provider_idx" ON "company_provider_credentials" USING btree ("company_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_provider_credentials_secret_idx" ON "company_provider_credentials" USING btree ("secret_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_provider_credentials_company_provider_label_uq" ON "company_provider_credentials" USING btree ("company_id","provider","label");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_provider_credentials_company_provider_secret_uq" ON "company_provider_credentials" USING btree ("company_id","provider","secret_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_provider_credentials_company_provider_default_uq" ON "company_provider_credentials" USING btree ("company_id","provider") WHERE "is_default" = true;
--> statement-breakpoint
INSERT INTO "company_provider_credentials" (
	"company_id",
	"provider",
	"env_key",
	"label",
	"secret_id",
	"is_default",
	"created_at",
	"updated_at"
)
SELECT
	"s"."company_id",
	CASE
		WHEN "s"."name" = 'OPENAI_API_KEY' THEN 'openai'
		WHEN "s"."name" = 'ANTHROPIC_API_KEY' THEN 'anthropic'
		WHEN "s"."name" = 'GEMINI_API_KEY' THEN 'gemini'
		WHEN "s"."name" = 'GOOGLE_API_KEY' THEN 'google'
		WHEN "s"."name" = 'CURSOR_API_KEY' THEN 'cursor'
		ELSE lower("s"."name")
	END,
	"s"."name",
	'Default',
	"s"."id",
	true,
	"s"."created_at",
	"s"."updated_at"
FROM "company_secrets" AS "s"
WHERE "s"."name" IN (
	'OPENAI_API_KEY',
	'ANTHROPIC_API_KEY',
	'GEMINI_API_KEY',
	'GOOGLE_API_KEY',
	'CURSOR_API_KEY'
)
ON CONFLICT DO NOTHING;
