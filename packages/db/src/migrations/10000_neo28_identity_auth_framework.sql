CREATE TABLE IF NOT EXISTS "identity_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"neoreef_id" text,
	"zoho_id" text,
	"paperclip_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_maps" ADD CONSTRAINT "identity_maps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_maps" ADD CONSTRAINT "identity_maps_paperclip_user_id_auth_users_id_fk" FOREIGN KEY ("paperclip_user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
 WHEN undefined_table THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_maps_company_idx" ON "identity_maps" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_maps_neoreef_id_idx" ON "identity_maps" USING btree ("neoreef_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_maps_zoho_id_idx" ON "identity_maps" USING btree ("zoho_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_maps_paperclip_user_id_idx" ON "identity_maps" USING btree ("paperclip_user_id");--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "acl_roles" text[];--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "auth_context" jsonb;
