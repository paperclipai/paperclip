CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" jsonb NOT NULL DEFAULT '[]',
	"active" boolean NOT NULL DEFAULT true,
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"attempt" integer NOT NULL DEFAULT 1,
	"next_attempt_at" timestamp with time zone,
	"http_status" integer,
	"latency_ms" integer,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"response_body" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
-- statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
-- statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;
-- statement-breakpoint
CREATE INDEX "webhook_endpoints_company_idx" ON "webhook_endpoints" USING btree ("company_id");
-- statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");
-- statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");
-- statement-breakpoint
CREATE INDEX "webhook_deliveries_next_attempt_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "next_attempt_at" IS NOT NULL;
