CREATE TABLE IF NOT EXISTS "qsl_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "fingerprint" text NOT NULL,
  "rule_id" text,
  "title" text NOT NULL,
  "severity" text,
  "threat_category" text,
  "review_state" text NOT NULL DEFAULT 'new',
  "review_decision" text,
  "reviewer_id" text,
  "reviewed_at" timestamp with time zone,
  "first_seen" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen" timestamp with time zone NOT NULL DEFAULT now(),
  "occurrence_count" integer NOT NULL DEFAULT 1,
  "latest_risk_score" integer,
  "latest_payload" jsonb,
  "review_history" jsonb DEFAULT '[]',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qsl_findings_company_fingerprint_idx"
  ON "qsl_findings" USING btree ("company_id","fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qsl_findings_company_review_state_idx"
  ON "qsl_findings" USING btree ("company_id","review_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qsl_findings_company_last_seen_idx"
  ON "qsl_findings" USING btree ("company_id","last_seen");
