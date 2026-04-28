CREATE TABLE "rt2_v33_knowledge_vault_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vault_name" text NOT NULL,
	"root_path" text NOT NULL,
	"export_subdirectory" text DEFAULT 'rt2-export' NOT NULL,
	"writer_mode" text DEFAULT 'dry_run' NOT NULL,
	"last_dry_run" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_knowledge_vault_settings" ADD CONSTRAINT "rt2_v33_knowledge_vault_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_knowledge_vault_settings_company_uq" ON "rt2_v33_knowledge_vault_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE TABLE "rt2_v33_knowledge_sync_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"file_path" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text DEFAULT 'system' NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_knowledge_sync_decisions" ADD CONSTRAINT "rt2_v33_knowledge_sync_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rt2_v33_knowledge_sync_decisions_company_created_idx" ON "rt2_v33_knowledge_sync_decisions" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "rt2_v33_knowledge_sync_decisions_company_page_idx" ON "rt2_v33_knowledge_sync_decisions" USING btree ("company_id","page_key");
