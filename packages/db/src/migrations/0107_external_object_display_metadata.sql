ALTER TABLE "external_objects" ADD COLUMN IF NOT EXISTS "display_key" text;
--> statement-breakpoint
ALTER TABLE "external_objects" ADD COLUMN IF NOT EXISTS "icon_key" text;
--> statement-breakpoint
ALTER TABLE "external_objects" ADD COLUMN IF NOT EXISTS "status_icon_key" text;
