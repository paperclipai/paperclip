CREATE TABLE "mcp_oauth_metadata_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mcp_oauth_metadata_admissions_expiry_idx" ON "mcp_oauth_metadata_admissions" USING btree ("expires_at");