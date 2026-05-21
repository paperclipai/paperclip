ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "compacted_at" timestamptz;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_retention_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
  "succeeded_run_retention_hours" integer NOT NULL DEFAULT 72,
  "failed_run_retention_hours" integer NOT NULL DEFAULT 168,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
