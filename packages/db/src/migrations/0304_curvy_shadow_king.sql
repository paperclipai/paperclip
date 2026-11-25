CREATE TABLE IF NOT EXISTS "mcp_oauth_device_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"requested_company_id" uuid,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"grant_id" uuid,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "grant_types" jsonb DEFAULT '["authorization_code","refresh_token"]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mcp_oauth_device_requests" ADD CONSTRAINT "mcp_oauth_device_requests_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mcp_oauth_device_requests" ADD CONSTRAINT "mcp_oauth_device_requests_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_device_code_uq" ON "mcp_oauth_device_requests" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_user_code_uq" ON "mcp_oauth_device_requests" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_device_expiry_idx" ON "mcp_oauth_device_requests" USING btree ("expires_at");
