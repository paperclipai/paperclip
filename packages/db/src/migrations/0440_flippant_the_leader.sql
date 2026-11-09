CREATE TABLE "mcp_oauth_client_changes" (
	"client_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	CONSTRAINT "mcp_client_change_revision" CHECK ("mcp_oauth_client_changes"."revision" >= 1),
	CONSTRAINT "mcp_client_change_operation" CHECK ("mcp_oauth_client_changes"."operation" IN ('upsert','delete'))
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_client_mirror_state" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"remote_responsibility" boolean DEFAULT false NOT NULL,
	"device_cutover_stack_id" text,
	"device_cutover_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"receipt" jsonb,
	CONSTRAINT "mcp_client_mirror_singleton" CHECK ("mcp_oauth_client_mirror_state"."id" = 'public'),
	CONSTRAINT "mcp_client_mirror_revision" CHECK ("mcp_oauth_client_mirror_state"."revision" >= 0),
	CONSTRAINT "mcp_device_cutover_identity" CHECK (("mcp_oauth_client_mirror_state"."device_cutover_at" IS NULL AND "mcp_oauth_client_mirror_state"."device_cutover_stack_id" IS NULL) OR ("mcp_oauth_client_mirror_state"."device_cutover_at" IS NOT NULL AND "mcp_oauth_client_mirror_state"."device_cutover_stack_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_device_requests" ADD COLUMN "ingress_owner" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "revocation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "revocation_index_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD COLUMN "revocation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_client_changes_revision_idx" ON "mcp_oauth_client_changes" USING btree ("revision","client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_revocation_revision_idx" ON "mcp_oauth_tokens" USING btree ("grant_id","revocation_revision","id");--> statement-breakpoint
ALTER TABLE "mcp_oauth_device_requests" ADD CONSTRAINT "mcp_device_ingress_owner" CHECK ("mcp_oauth_device_requests"."ingress_owner" IN ('tenant','cloud'));