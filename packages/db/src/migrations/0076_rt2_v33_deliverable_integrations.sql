CREATE TABLE "rt2_v33_external_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"email" text,
	"display_name" text,
	"access_token" text,
	"refresh_token" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_expires_at" timestamp with time zone,
	"vault_name" text,
	"vault_root" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_external_accounts_provider_check" CHECK ("provider" in ('google', 'obsidian')),
	CONSTRAINT "rt2_v33_external_accounts_status_check" CHECK ("status" in ('connected', 'disconnected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_deliverable_sync_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid NOT NULL,
	"work_product_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"sync_direction" text NOT NULL,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"label" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_pulled_content_hash" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_deliverable_sync_links_provider_check" CHECK ("provider" in ('google_docs', 'google_sheets', 'google_drive', 'obsidian')),
	CONSTRAINT "rt2_v33_deliverable_sync_links_direction_check" CHECK ("sync_direction" in ('push', 'pull', 'bidirectional')),
	CONSTRAINT "rt2_v33_deliverable_sync_links_status_check" CHECK ("sync_status" in ('pending', 'linked', 'syncing', 'error'))
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_external_accounts" ADD CONSTRAINT "rt2_v33_external_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_deliverable_sync_links" ADD CONSTRAINT "rt2_v33_deliverable_sync_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_deliverable_sync_links" ADD CONSTRAINT "rt2_v33_deliverable_sync_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_deliverable_sync_links" ADD CONSTRAINT "rt2_v33_deliverable_sync_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_deliverable_sync_links" ADD CONSTRAINT "rt2_v33_deliverable_sync_links_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_external_accounts_company_user_provider_uq" ON "rt2_v33_external_accounts" USING btree ("company_id","user_id","provider");
--> statement-breakpoint
CREATE INDEX "rt2_v33_external_accounts_company_provider_status_idx" ON "rt2_v33_external_accounts" USING btree ("company_id","provider","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_deliverable_sync_links_company_work_product_provider_uq" ON "rt2_v33_deliverable_sync_links" USING btree ("company_id","work_product_id","provider");
--> statement-breakpoint
CREATE INDEX "rt2_v33_deliverable_sync_links_company_project_provider_idx" ON "rt2_v33_deliverable_sync_links" USING btree ("company_id","project_id","provider");
