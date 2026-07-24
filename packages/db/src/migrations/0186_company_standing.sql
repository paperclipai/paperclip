CREATE TABLE IF NOT EXISTS "company_standing" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "plugin_id" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "message" text NOT NULL,
  "action_url" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_standing_pkey" PRIMARY KEY ("company_id", "plugin_id"),
  CONSTRAINT "company_standing_status_check" CHECK ("status" IN ('active', 'grace', 'blocked'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_standing_company_idx"
  ON "company_standing" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_standing_plugin_idx"
  ON "company_standing" USING btree ("plugin_id");
