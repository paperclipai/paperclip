ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;