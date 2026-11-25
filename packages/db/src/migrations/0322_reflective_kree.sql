CREATE TABLE IF NOT EXISTS "ai_subscription_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"credential_key" text NOT NULL,
	"subscription_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_subscription_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"plan" text NOT NULL,
	"amount_cents" numeric(24, 7),
	"currency" text DEFAULT 'USD' NOT NULL,
	"cadence" text DEFAULT 'month' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_subscription_prices_valid" CHECK (("ai_subscription_prices"."amount_cents" is null or "ai_subscription_prices"."amount_cents" >= 0) and "ai_subscription_prices"."cadence" in ('month','year') and "ai_subscription_prices"."status" in ('active','ended','excluded') and "ai_subscription_prices"."source" in ('catalog','user','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_key" text NOT NULL,
	"identity_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"owner_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"detected_plan" text,
	"observed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"refresh_status" text,
	"merged_into_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_subscriptions_no_self_merge" CHECK ("ai_subscriptions"."merged_into_id" is null or "ai_subscriptions"."merged_into_id" <> "ai_subscriptions"."id")
);
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "subscription_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscription_connections_company_id_companies_id_fk' AND conrelid = 'ai_subscription_connections'::regclass) THEN
    ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscription_connections_connection_id_tool_connections_id_fk' AND conrelid = 'ai_subscription_connections'::regclass) THEN
    ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscription_connections_grant_id_connection_grants_id_fk' AND conrelid = 'ai_subscription_connections'::regclass) THEN
    ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscription_connections_subscription_id_ai_subscriptions_id_fk' AND conrelid = 'ai_subscription_connections'::regclass) THEN
    ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_subscription_id_ai_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscription_prices_company_id_companies_id_fk' AND conrelid = 'ai_subscription_prices'::regclass) THEN
    ALTER TABLE "ai_subscription_prices" ADD CONSTRAINT "ai_subscription_prices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscription_prices_subscription_id_ai_subscriptions_id_fk' AND conrelid = 'ai_subscription_prices'::regclass) THEN
    ALTER TABLE "ai_subscription_prices" ADD CONSTRAINT "ai_subscription_prices_subscription_id_ai_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscriptions_company_id_companies_id_fk' AND conrelid = 'ai_subscriptions'::regclass) THEN
    ALTER TABLE "ai_subscriptions" ADD CONSTRAINT "ai_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subscriptions_merged_into_id_ai_subscriptions_id_fk' AND conrelid = 'ai_subscriptions'::regclass) THEN
    ALTER TABLE "ai_subscriptions" ADD CONSTRAINT "ai_subscriptions_merged_into_id_ai_subscriptions_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_subscription_connections_grant_idx" ON "ai_subscription_connections" USING btree ("company_id","grant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_subscription_connections_credential_idx" ON "ai_subscription_connections" USING btree ("company_id","credential_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_subscription_connections_account_idx" ON "ai_subscription_connections" USING btree ("company_id","subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_subscription_prices_revision_idx" ON "ai_subscription_prices" USING btree ("subscription_id","revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_subscription_prices_company_idx" ON "ai_subscription_prices" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_subscriptions_identity_idx" ON "ai_subscriptions" USING btree ("company_id","provider","account_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_subscriptions_company_idx" ON "ai_subscriptions" USING btree ("company_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_events_subscription_id_ai_subscriptions_id_fk' AND conrelid = 'cost_events'::regclass) THEN
    ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_subscription_id_ai_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_company_subscription_occurred_idx" ON "cost_events" USING btree ("company_id","subscription_id","occurred_at");