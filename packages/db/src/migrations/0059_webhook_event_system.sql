CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "url" text NOT NULL,
  "secret" text,
  "description" text,
  "event_types" text[],
  "project_id" uuid,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade,
  CONSTRAINT "webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhooks_company_active_idx" ON "webhooks" USING btree ("company_id", "active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "webhook_id" uuid NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "status_code" integer,
  "response_body" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "next_retry_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhook_status_idx" ON "webhook_deliveries" USING btree ("webhook_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_next_retry_idx" ON "webhook_deliveries" USING btree ("status", "next_retry_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_event_type_idx" ON "webhook_deliveries" USING btree ("event_type");
