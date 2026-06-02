CREATE TABLE "company_infra_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"mode" text DEFAULT 'managed_shared' NOT NULL,
	"status" text DEFAULT 'entitled' NOT NULL,
	"provider" text,
	"binding_ref" text,
	"provisioned_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "founder_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "infra_mode" text DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_infra_entitlements" ADD CONSTRAINT "company_infra_entitlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_infra_entitlements_company_idx" ON "company_infra_entitlements" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_infra_entitlements_company_capability_uq" ON "company_infra_entitlements" USING btree ("company_id","capability");
