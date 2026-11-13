CREATE TABLE IF NOT EXISTS "company_skill_security_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"approval" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_skill_security_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_security_approvals_company_content_idx" ON "company_skill_security_approvals" USING btree ("company_id","content_hash");--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "security_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_security_approval_id_company_skill_security_approvals_id_fk" FOREIGN KEY ("security_approval_id") REFERENCES "public"."company_skill_security_approvals"("id") ON DELETE restrict ON UPDATE no action NOT VALID;