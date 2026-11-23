CREATE TABLE "company_skill_import_budgets" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"available_bytes" integer DEFAULT 536870912 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skill_import_budgets" ADD CONSTRAINT "company_skill_import_budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;