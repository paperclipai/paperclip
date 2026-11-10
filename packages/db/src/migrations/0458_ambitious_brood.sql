CREATE TABLE "project_provider_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"scope_key" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"authorized_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_provider_authorizations_provider_check" CHECK ("project_provider_authorizations"."provider" ~ '^[a-z][a-z0-9-]{0,31}$')
);
--> statement-breakpoint
ALTER TABLE "project_provider_authorizations" ADD CONSTRAINT "project_provider_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_provider_authorizations" ADD CONSTRAINT "project_provider_authorizations_company_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_provider_authorizations" ADD CONSTRAINT "project_provider_authorizations_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_provider_authorizations_project_provider_scope_uq" ON "project_provider_authorizations" USING btree ("project_id","provider","scope_key");--> statement-breakpoint
CREATE INDEX "project_provider_authorizations_company_project_idx" ON "project_provider_authorizations" USING btree ("company_id","project_id");