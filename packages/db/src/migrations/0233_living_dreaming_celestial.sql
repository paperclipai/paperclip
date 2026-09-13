ALTER TABLE "connection_grants" ADD COLUMN IF NOT EXISTS "external_credential" jsonb;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "credential_source" text DEFAULT 'paperclip_vault' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "external_credential" jsonb;--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_credential_source_one_of_check";--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_credential_source_one_of_check" CHECK ("connection_grants"."external_credential" is null or jsonb_array_length("connection_grants"."credential_secret_refs") = 0);--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_source_check";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_source_check" CHECK ("tool_connections"."credential_source" in ('paperclip_vault', 'vercel_connect'));--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_source_one_of_check";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_source_one_of_check" CHECK ((
      ("tool_connections"."credential_source" = 'paperclip_vault' and "tool_connections"."external_credential" is null)
      or
      ("tool_connections"."credential_source" = 'vercel_connect' and "tool_connections"."external_credential" is not null and jsonb_array_length("tool_connections"."credential_refs") = 0 and jsonb_array_length("tool_connections"."credential_secret_refs") = 0)
    ));
