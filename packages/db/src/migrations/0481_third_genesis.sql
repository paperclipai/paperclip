-- paperclip:migration-compat online_compatible: Nullable metadata ignored by older releases; backfill touches only connector-referenced secret rows through their primary keys.
ALTER TABLE "company_secrets" ADD COLUMN "system_purpose" text;
--> statement-breakpoint
UPDATE "company_secrets" AS secret
SET "system_purpose" = 'tailscale_network'
FROM "tailscale_connections" AS connection
WHERE secret.id = connection.secret_id AND secret.company_id = connection.company_id;
