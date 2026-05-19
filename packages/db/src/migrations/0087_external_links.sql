CREATE TABLE IF NOT EXISTS "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_key" text NOT NULL,
	"external_url" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_links_platform_check" CHECK (platform IN ('jira','linear','github','asana'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_links_issue_id_issues_id_fk') THEN
  ALTER TABLE "external_links" ADD CONSTRAINT "external_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_links_issue_idx" ON "external_links" USING btree ("issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_links_reverse_idx" ON "external_links" USING btree ("platform","external_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_links_issue_platform_key_uq" ON "external_links" USING btree ("issue_id","platform","external_key");
