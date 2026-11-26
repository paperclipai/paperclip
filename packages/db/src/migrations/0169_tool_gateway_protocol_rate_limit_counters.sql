CREATE TABLE IF NOT EXISTS "tool_gateway_rate_limit_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "counter_key" text NOT NULL,
  "window_start_at" timestamp with time zone NOT NULL,
  "window_ms" integer NOT NULL,
  "limit" integer NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "reset_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_gateway_rate_limit_counters_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_gateway_rate_limit_counters"
      ADD CONSTRAINT "tool_gateway_rate_limit_counters_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_gateway_rate_limit_counters_window_bounds'
  ) THEN
    ALTER TABLE "tool_gateway_rate_limit_counters"
      ADD CONSTRAINT "tool_gateway_rate_limit_counters_window_bounds"
      CHECK ("window_ms" > 0 AND "limit" > 0 AND "count" >= 0);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_rate_limit_counters_company_idx"
  ON "tool_gateway_rate_limit_counters" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_gateway_rate_limit_counters_window_uq"
  ON "tool_gateway_rate_limit_counters" USING btree ("company_id","counter_key","window_start_at");
