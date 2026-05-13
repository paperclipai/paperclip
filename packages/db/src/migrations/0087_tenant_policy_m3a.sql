ALTER TABLE "cluster_tenant_policies" ADD COLUMN IF NOT EXISTS "git_credentials_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "cluster_tenant_policies" ADD COLUMN IF NOT EXISTS "cilium_dns_allowlist" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_tenant_policies" ADD COLUMN IF NOT EXISTS "cilium_egress_cidrs" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cluster_tenant_policies_git_credentials_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "cluster_tenant_policies" ADD CONSTRAINT "cluster_tenant_policies_git_credentials_secret_id_company_secrets_id_fk" FOREIGN KEY ("git_credentials_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
