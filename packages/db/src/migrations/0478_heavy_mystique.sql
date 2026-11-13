CREATE TABLE "company_staff_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"job_title" text,
	"org_role" text,
	"capabilities" text,
	"reports_to_principal_type" text,
	"reports_to_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reports_to_user_id" text;--> statement-breakpoint
ALTER TABLE "company_staff_profiles" ADD CONSTRAINT "company_staff_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_staff_profiles_company_user_unique_idx" ON "company_staff_profiles" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "company_staff_profiles_company_reports_idx" ON "company_staff_profiles" USING btree ("company_id","reports_to_principal_type","reports_to_principal_id");