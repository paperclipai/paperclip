CREATE TABLE "company_user_ui_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"surface" text NOT NULL,
	"schema_version" integer NOT NULL,
	"layout" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_user_ui_layouts" ADD CONSTRAINT "company_user_ui_layouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_user_ui_layouts_company_idx" ON "company_user_ui_layouts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_user_ui_layouts_company_user_surface_uq" ON "company_user_ui_layouts" USING btree ("company_id","user_id","surface");