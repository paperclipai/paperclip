CREATE UNIQUE INDEX IF NOT EXISTS "rt2_settlement_company_work_product_uq"
  ON "rt2_settlement_governance" ("company_id", "work_product_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rt2_settlement_thresholds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "high_value_gold" integer DEFAULT 1000 NOT NULL,
  "self_review_critical_count" integer DEFAULT 2 NOT NULL,
  "gold_farming_earned_count" integer DEFAULT 5 NOT NULL,
  "gold_farming_warning_gold" integer DEFAULT 1500 NOT NULL,
  "gold_farming_warning_multiplier" integer DEFAULT 3 NOT NULL,
  "gold_farming_critical_gold" integer DEFAULT 2500 NOT NULL,
  "gold_farming_critical_multiplier" integer DEFAULT 5 NOT NULL,
  "quality_bias_auto_score" integer DEFAULT 98 NOT NULL,
  "evaluation_window_days" integer DEFAULT 30 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_settlement_thresholds_company_uq"
  ON "rt2_settlement_thresholds" ("company_id");
