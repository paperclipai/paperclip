CREATE TABLE "emisso_tenant_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"emisso_tenant_id" text NOT NULL,
	"emisso_project_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emisso_tenant_map" ADD CONSTRAINT "emisso_tenant_map_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "emisso_tenant_map_company_idx" ON "emisso_tenant_map" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emisso_tenant_map_tenant_idx" ON "emisso_tenant_map" USING btree ("emisso_tenant_id");