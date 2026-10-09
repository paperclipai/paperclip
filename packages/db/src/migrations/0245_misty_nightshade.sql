ALTER TABLE "run_identity_contexts" DROP CONSTRAINT IF EXISTS "run_identity_contexts_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "run_identity_contexts" ADD CONSTRAINT "run_identity_contexts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;