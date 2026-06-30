CREATE TABLE IF NOT EXISTS "claude_account_usage" (
	"profile" text PRIMARY KEY NOT NULL,
	"email" text,
	"subscription_type" text,
	"tier" text DEFAULT 'unknown' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"five_hour_pct" integer,
	"five_hour_resets_at" timestamp with time zone,
	"seven_day_pct" integer,
	"seven_day_resets_at" timestamp with time zone,
	"seven_day_opus_pct" integer,
	"seven_day_opus_resets_at" timestamp with time zone,
	"seven_day_sonnet_pct" integer,
	"seven_day_sonnet_resets_at" timestamp with time zone,
	"source" text DEFAULT 'error' NOT NULL,
	"error" text,
	"probed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_account_usage_probed_at_idx" ON "claude_account_usage" USING btree ("probed_at");
