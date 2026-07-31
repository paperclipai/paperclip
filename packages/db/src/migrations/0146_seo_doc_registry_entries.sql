CREATE TABLE "seo_doc_registry_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "doc_key" text NOT NULL,
  "issue_id" uuid NOT NULL,
  "issue_document_key" text NOT NULL,
  "title" text NOT NULL,
  "issue_link" text NOT NULL,
  "owner" text NOT NULL,
  "last_updated" timestamp with time zone NOT NULL,
  "update_cadence" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "document_class" text NOT NULL,
  "criticality" text DEFAULT 'normal' NOT NULL,
  "last_audited_at" timestamp with time zone,
  "last_escalated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seo_doc_registry_entries" ADD CONSTRAINT "seo_doc_registry_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "seo_doc_registry_entries" ADD CONSTRAINT "seo_doc_registry_entries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "seo_doc_registry_entries_company_doc_key_uq" ON "seo_doc_registry_entries" USING btree ("company_id","doc_key");
--> statement-breakpoint
CREATE INDEX "seo_doc_registry_entries_company_status_idx" ON "seo_doc_registry_entries" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "seo_doc_registry_entries_company_issue_idx" ON "seo_doc_registry_entries" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX "seo_doc_registry_entries_company_last_updated_idx" ON "seo_doc_registry_entries" USING btree ("company_id","last_updated");
