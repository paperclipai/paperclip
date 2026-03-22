CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"filters" jsonb NOT NULL,
	"group_by" text DEFAULT 'none' NOT NULL,
	"sort_field" text DEFAULT 'updated' NOT NULL,
	"sort_direction" text DEFAULT 'desc' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_company_idx" ON "saved_views" USING btree ("company_id");
