ALTER TABLE "company_secret_proposals" DROP CONSTRAINT IF EXISTS "company_secret_proposals_secret_id_company_secrets_id_fk";
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;