CREATE TABLE IF NOT EXISTS "rt2_settlement_governance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "work_product_id" uuid NOT NULL,
  "task_issue_id" uuid NOT NULL,
  "owner_actor_id" text NOT NULL,
  "owner_actor_type" text NOT NULL,
  "proposed_price_gold" integer NOT NULL,
  "final_price_gold" integer,
  "rationale" text NOT NULL,
  "negotiation_comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "approval_required" integer DEFAULT 0 NOT NULL,
  "approval_gate_reason" text,
  "risk_level" text DEFAULT 'low' NOT NULL,
  "anti_gaming_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approver_id" text,
  "decision_reason" text,
  "ledger_entry_id" uuid,
  "pnl_period" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_settlement_company_status_idx"
  ON "rt2_settlement_governance" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "rt2_settlement_work_product_idx"
  ON "rt2_settlement_governance" ("company_id", "work_product_id");
CREATE INDEX IF NOT EXISTS "rt2_settlement_owner_idx"
  ON "rt2_settlement_governance" ("company_id", "owner_actor_id", "owner_actor_type");

CREATE TABLE IF NOT EXISTS "rt2_anti_gaming_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "settlement_id" uuid REFERENCES "rt2_settlement_governance"("id") ON DELETE cascade,
  "actor_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "signal_type" text NOT NULL,
  "severity" text NOT NULL,
  "evidence" text NOT NULL,
  "reference_id" text,
  "reference_type" text,
  "used_in_decision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_anti_gaming_company_actor_idx"
  ON "rt2_anti_gaming_signals" ("company_id", "actor_id", "actor_type");
CREATE INDEX IF NOT EXISTS "rt2_anti_gaming_settlement_idx"
  ON "rt2_anti_gaming_signals" ("settlement_id");
