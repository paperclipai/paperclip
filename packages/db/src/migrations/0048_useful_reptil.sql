CREATE TABLE IF NOT EXISTS "company_email_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agentmail_api_key" text,
	"agentmail_inbox_id" text,
	"agentmail_email" text,
	"agentmail_display_name" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_email_settings_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_vault" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"secret_value" text NOT NULL,
	"masked_preview" text NOT NULL,
	"source" text DEFAULT 'comment' NOT NULL,
	"source_comment_id" uuid,
	"source_issue_id" uuid,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_email_settings" ADD CONSTRAINT "company_email_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_vault" ADD CONSTRAINT "company_vault_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_vault_company_idx" ON "company_vault" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_vault_company_category_idx" ON "company_vault" USING btree ("company_id","category");
