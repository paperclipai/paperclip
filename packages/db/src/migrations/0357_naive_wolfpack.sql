CREATE TABLE IF NOT EXISTS "company_observability" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"revision" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"destination" jsonb NOT NULL,
	"capture" jsonb NOT NULL,
	"credentials_secret_id" uuid,
	"header_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_test" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_observability" ADD CONSTRAINT "company_observability_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_observability" ADD CONSTRAINT "company_observability_credentials_secret_id_company_secrets_id_fk" FOREIGN KEY ("credentials_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
