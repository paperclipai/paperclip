CREATE TABLE IF NOT EXISTS "tool_runtime_metric_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "bucket_start_at" timestamp with time zone NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_runtime_metric_counters_count_nonnegative" CHECK ("count" >= 0)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_runtime_metric_counters_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_runtime_metric_counters"
      ADD CONSTRAINT "tool_runtime_metric_counters_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_runtime_metric_counters_company_metric_idx"
  ON "tool_runtime_metric_counters" USING btree ("company_id", "metric", "bucket_start_at");

CREATE UNIQUE INDEX IF NOT EXISTS "tool_runtime_metric_counters_bucket_uq"
  ON "tool_runtime_metric_counters" USING btree ("company_id", "metric", "bucket_start_at");
