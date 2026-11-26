CREATE TABLE IF NOT EXISTS "mcp_attachment_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"arguments_hash" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"attachment_id" uuid,
	"object_key" text NOT NULL,
	"storage_provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cleaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_file_tickets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"upload_id" uuid,
	"attachment_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_attachment_uploads" ADD CONSTRAINT "mcp_attachment_uploads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_attachment_uploads" ADD CONSTRAINT "mcp_attachment_uploads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_file_tickets" ADD CONSTRAINT "mcp_file_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_file_tickets" ADD CONSTRAINT "mcp_file_tickets_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_file_tickets" ADD CONSTRAINT "mcp_file_tickets_upload_id_mcp_attachment_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."mcp_attachment_uploads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_attachment_upload_request_uq" ON "mcp_attachment_uploads" USING btree ("company_id","user_id","request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_attachment_upload_expiry_idx" ON "mcp_attachment_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_file_ticket_expiry_idx" ON "mcp_file_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_file_ticket_grant_idx" ON "mcp_file_tickets" USING btree ("grant_id");
