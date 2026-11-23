CREATE TABLE IF NOT EXISTS "link_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL CONSTRAINT "link_previews_company_id_companies_id_fk" REFERENCES "public"."companies"("id") ON DELETE cascade,
	"viewer_id" text NOT NULL,
	"channel" text NOT NULL,
	"resource_kind" text NOT NULL,
	"canonical_url" text NOT NULL,
	"status" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "link_previews_scope_url_uq" ON "link_previews" USING btree ("company_id","viewer_id","canonical_url");
