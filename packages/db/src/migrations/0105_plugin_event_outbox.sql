-- Cross-tier delivery outbox for plugin domain events.
-- Hand-authored tail migration (the drizzle journal is intentionally stale at
-- 0102; 0103/0104 are also hand-authored). Do NOT run drizzle-kit generate.
-- The apply path wraps each statement in a SAVEPOINT and swallows
-- duplicate-object errors, so IF NOT EXISTS + the FK guard make this re-apply-safe.
CREATE TABLE IF NOT EXISTS "plugin_event_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "event_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "plugin_event_outbox"
    ADD CONSTRAINT "plugin_event_outbox_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_event_outbox_status_seq_idx"
  ON "plugin_event_outbox" USING btree ("status", "seq");
