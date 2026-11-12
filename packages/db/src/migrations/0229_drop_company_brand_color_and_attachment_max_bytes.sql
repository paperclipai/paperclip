-- Drop the two retired per-company settings. "brand_color" only tinted the
-- generated company icon, which now always derives its hue from the company
-- name, and "attachment_max_bytes" duplicated the deployment-level
-- PAPERCLIP_ATTACHMENT_MAX_BYTES cap that already bounds every upload. Both
-- columns lost their last reader when the settings were removed.
ALTER TABLE "companies" DROP COLUMN IF EXISTS "attachment_max_bytes";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN IF EXISTS "brand_color";
