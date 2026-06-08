ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_type" text NOT NULL DEFAULT 'other';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "archived_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "archived_by_user_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_status_updated_idx" ON "documents" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_type_updated_idx" ON "documents" USING btree ("company_id","document_type","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_company_owner_agent_updated_idx" ON "documents" USING btree ("company_id","owner_agent_id","updated_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "relationship" text DEFAULT 'related' NOT NULL,
  "issue_document_id" uuid,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_links" ADD CONSTRAINT "document_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_links" ADD CONSTRAINT "document_links_issue_document_id_issue_documents_id_fk" FOREIGN KEY ("issue_document_id") REFERENCES "public"."issue_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_links" ADD CONSTRAINT "document_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_links_document_target_uq" ON "document_links" USING btree ("company_id","document_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_links_company_target_idx" ON "document_links" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_links_company_document_idx" ON "document_links" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_links_issue_document_idx" ON "document_links" USING btree ("issue_document_id");--> statement-breakpoint
INSERT INTO "document_links" (
  "company_id",
  "document_id",
  "target_type",
  "target_id",
  "relationship",
  "issue_document_id",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  "document_id",
  'issue',
  "issue_id",
  'issue_document',
  "id",
  "created_at",
  "updated_at"
FROM "issue_documents"
ON CONFLICT ("company_id","document_id","target_type","target_id") DO NOTHING;
