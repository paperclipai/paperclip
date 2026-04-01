CREATE TABLE IF NOT EXISTS "messaging_bridges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "platform" text NOT NULL,
  "status" text NOT NULL DEFAULT 'disconnected',
  "last_error" text,
  "config" jsonb DEFAULT '{}',
  "secret_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_bridges_company_idx" ON "messaging_bridges" ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messaging_bridges_company_platform_uq" ON "messaging_bridges" ("company_id", "platform");
