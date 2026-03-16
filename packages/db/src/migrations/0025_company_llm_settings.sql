CREATE TABLE "company_llm_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"preferred_provider_type" text,
	"preferred_model_id" text,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_llm_settings_company_id_idx" UNIQUE("company_id"),
	CONSTRAINT "company_llm_settings_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade
);
