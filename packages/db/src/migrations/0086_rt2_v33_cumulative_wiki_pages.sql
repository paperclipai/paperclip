CREATE TABLE "rt2_v33_wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"page_type" text NOT NULL,
	"title" text NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_wiki_pages" ADD CONSTRAINT "rt2_v33_wiki_pages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_wiki_pages_company_page_key_uq" ON "rt2_v33_wiki_pages" USING btree ("company_id","page_key");
--> statement-breakpoint
CREATE INDEX "rt2_v33_wiki_pages_company_type_updated_idx" ON "rt2_v33_wiki_pages" USING btree ("company_id","page_type","updated_at");
