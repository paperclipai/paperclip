CREATE TABLE "business_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "product_name" text,
  "product_url" text,
  "healthcheck_url" text,
  "default_currency" text DEFAULT 'usd' NOT NULL,
  "telegram_chat_id" text,
  "notification_email" text,
  "telegram_enabled" boolean DEFAULT false NOT NULL,
  "email_enabled" boolean DEFAULT false NOT NULL,
  "daily_brief_telegram" boolean DEFAULT true NOT NULL,
  "alert_telegram" boolean DEFAULT true NOT NULL,
  "daily_brief_email" boolean DEFAULT false NOT NULL,
  "alert_email" boolean DEFAULT false NOT NULL,
  "stripe_secret_key_name" text DEFAULT 'business-stripe-secret-key' NOT NULL,
  "stripe_webhook_secret_name" text DEFAULT 'business-stripe-webhook-secret' NOT NULL,
  "telegram_bot_token_secret_name" text DEFAULT 'business-telegram-bot-token' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_configs_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_configs_company_idx" ON "business_configs" USING btree ("company_id");
--> statement-breakpoint
CREATE TABLE "business_kpis" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "kpi_date" date NOT NULL,
  "mrr_cents" integer DEFAULT 0 NOT NULL,
  "total_revenue_cents" integer DEFAULT 0 NOT NULL,
  "total_costs_cents" integer DEFAULT 0 NOT NULL,
  "net_profit_cents" integer DEFAULT 0 NOT NULL,
  "margin_percent" numeric(7, 2) DEFAULT '0' NOT NULL,
  "ltv_cents" integer,
  "cac_cents" integer,
  "ltv_cac_ratio" numeric(7, 2),
  "monthly_churn_rate" numeric(7, 4),
  "burn_rate_cents" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_kpis_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_kpis_company_date_idx" ON "business_kpis" USING btree ("company_id", "kpi_date");
--> statement-breakpoint
CREATE INDEX "business_kpis_company_kpi_idx" ON "business_kpis" USING btree ("company_id", "kpi_date");
--> statement-breakpoint
CREATE TABLE "infra_costs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "category" text NOT NULL,
  "description" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "infra_costs_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "infra_costs_company_effective_idx" ON "infra_costs" USING btree ("company_id", "effective_from");
--> statement-breakpoint
CREATE TABLE "notification_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "recipient" text NOT NULL,
  "notification_type" text NOT NULL,
  "subject" text,
  "body" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_log_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "notification_log_company_created_idx" ON "notification_log" USING btree ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX "notification_log_company_type_created_idx" ON "notification_log" USING btree ("company_id", "notification_type", "created_at");
--> statement-breakpoint
CREATE TABLE "product_health_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "endpoint_url" text NOT NULL,
  "status" text NOT NULL,
  "http_status" integer,
  "response_ms" integer,
  "error" text,
  "ssl_expires_at" timestamp with time zone,
  "checked_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_health_checks_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "product_health_checks_company_checked_idx" ON "product_health_checks" USING btree ("company_id", "checked_at");
--> statement-breakpoint
CREATE INDEX "product_health_checks_company_status_checked_idx" ON "product_health_checks" USING btree ("company_id", "status", "checked_at");
--> statement-breakpoint
CREATE TABLE "revenue_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "source" text NOT NULL,
  "event_type" text NOT NULL,
  "stripe_event_id" text,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "customer_id" text,
  "customer_email" text,
  "subscription_id" text,
  "product_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "revenue_events_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "revenue_events_company_occurred_idx" ON "revenue_events" USING btree ("company_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "revenue_events_company_type_occurred_idx" ON "revenue_events" USING btree ("company_id", "event_type", "occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_events_stripe_event_idx" ON "revenue_events" USING btree ("stripe_event_id");
--> statement-breakpoint
CREATE TABLE "user_metrics_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "snapshot_date" date NOT NULL,
  "total_users" integer DEFAULT 0 NOT NULL,
  "paid_users" integer DEFAULT 0 NOT NULL,
  "free_users" integer DEFAULT 0 NOT NULL,
  "new_signups" integer DEFAULT 0 NOT NULL,
  "churned" integer DEFAULT 0 NOT NULL,
  "mrr_cents" integer DEFAULT 0 NOT NULL,
  "arr_cents" integer DEFAULT 0 NOT NULL,
  "arpu_cents" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_metrics_snapshots_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_metrics_snapshots_company_date_idx" ON "user_metrics_snapshots" USING btree ("company_id", "snapshot_date");
--> statement-breakpoint
CREATE INDEX "user_metrics_snapshots_company_snapshot_idx" ON "user_metrics_snapshots" USING btree ("company_id", "snapshot_date");
