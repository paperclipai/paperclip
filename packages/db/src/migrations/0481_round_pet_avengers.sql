ALTER TABLE "tailscale_connections" ADD COLUMN "credential_version" integer;--> statement-breakpoint
ALTER TABLE "tailscale_connections" ADD COLUMN "credential_hash" text;