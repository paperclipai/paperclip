CREATE TABLE IF NOT EXISTS "company_state_repo_remotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_url" text NOT NULL,
	"secret_id" uuid,
	"secret_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_state_repo_remotes_company_uq" UNIQUE("company_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_state_repo_remotes" ADD CONSTRAINT "company_state_repo_remotes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_state_repo_remotes" ADD CONSTRAINT "company_state_repo_remotes_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
