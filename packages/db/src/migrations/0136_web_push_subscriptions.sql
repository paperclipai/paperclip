CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"device_label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_push_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_push_subscriptions_company_endpoint_idx" ON "web_push_subscriptions" USING btree ("company_id","endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_company_idx" ON "web_push_subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_created_at_idx" ON "web_push_subscriptions" USING btree ("created_at");
