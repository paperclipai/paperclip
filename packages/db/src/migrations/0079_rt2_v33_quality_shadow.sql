ALTER TABLE "rt2_v33_coin_ledger" ADD COLUMN "work_product_id" uuid;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" DROP CONSTRAINT IF EXISTS "rt2_v33_coin_ledger_entry_kind_check";
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" DROP CONSTRAINT IF EXISTS "rt2_v33_coin_ledger_gold_delta_check";
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" DROP CONSTRAINT IF EXISTS "rt2_v33_coin_ledger_xp_delta_check";
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_entry_kind_check" CHECK ("rt2_v33_coin_ledger"."entry_kind" in ('task_completion', 'manual_award', 'manual_reversal', 'quality_bonus', 'quality_penalty_shadow'));
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_gold_delta_check" CHECK ((("rt2_v33_coin_ledger"."entry_kind" in ('task_completion', 'manual_award', 'quality_bonus') and "rt2_v33_coin_ledger"."gold_delta" >= 0) or ("rt2_v33_coin_ledger"."entry_kind" = 'manual_reversal' and "rt2_v33_coin_ledger"."gold_delta" <= 0) or ("rt2_v33_coin_ledger"."entry_kind" = 'quality_penalty_shadow' and "rt2_v33_coin_ledger"."gold_delta" = 0)));
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_xp_delta_check" CHECK ((("rt2_v33_coin_ledger"."entry_kind" in ('task_completion', 'manual_award', 'quality_bonus') and "rt2_v33_coin_ledger"."xp_delta" >= 0) or ("rt2_v33_coin_ledger"."entry_kind" = 'manual_reversal' and "rt2_v33_coin_ledger"."xp_delta" <= 0) or ("rt2_v33_coin_ledger"."entry_kind" = 'quality_penalty_shadow' and "rt2_v33_coin_ledger"."xp_delta" = 0)));
--> statement-breakpoint
DROP INDEX IF EXISTS "rt2_v33_coin_ledger_company_task_user_settlement_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_coin_ledger_company_task_user_wp_settlement_uq" ON "rt2_v33_coin_ledger" USING btree (
  "company_id",
  "task_issue_id",
  "user_id",
  coalesce("work_product_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "entry_kind",
  "settlement_state"
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_quality_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "task_issue_id" uuid NOT NULL,
  "todo_issue_id" uuid NOT NULL,
  "work_product_id" uuid NOT NULL,
  "subject_user_id" text NOT NULL,
  "reviewer_user_id" text NOT NULL,
  "phase_mode" text DEFAULT 'shadow' NOT NULL,
  "completeness_score" integer NOT NULL,
  "accuracy_score" integer NOT NULL,
  "readability_score" integer NOT NULL,
  "timeliness_score" integer NOT NULL,
  "added_value_score" integer NOT NULL,
  "total_score" integer NOT NULL,
  "bonus_gold_delta" integer DEFAULT 0 NOT NULL,
  "penalty_gold_delta" integer DEFAULT 0 NOT NULL,
  "applied_gold_delta" integer DEFAULT 0 NOT NULL,
  "summary" text NOT NULL,
  "shadow_summary" text NOT NULL,
  "evidence_tag" text DEFAULT 'EXTRACTED' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rt2_v33_quality_checks_phase_mode_check" CHECK ("rt2_v33_quality_checks"."phase_mode" in ('shadow', 'co_pilot', 'auto')),
  CONSTRAINT "rt2_v33_quality_checks_completeness_score_check" CHECK ("rt2_v33_quality_checks"."completeness_score" between 0 and 100),
  CONSTRAINT "rt2_v33_quality_checks_accuracy_score_check" CHECK ("rt2_v33_quality_checks"."accuracy_score" between 0 and 100),
  CONSTRAINT "rt2_v33_quality_checks_readability_score_check" CHECK ("rt2_v33_quality_checks"."readability_score" between 0 and 100),
  CONSTRAINT "rt2_v33_quality_checks_timeliness_score_check" CHECK ("rt2_v33_quality_checks"."timeliness_score" between 0 and 100),
  CONSTRAINT "rt2_v33_quality_checks_added_value_score_check" CHECK ("rt2_v33_quality_checks"."added_value_score" between 0 and 100),
  CONSTRAINT "rt2_v33_quality_checks_total_score_check" CHECK ("rt2_v33_quality_checks"."total_score" between 0 and 100),
  CONSTRAINT "rt2_v33_quality_checks_bonus_gold_delta_check" CHECK ("rt2_v33_quality_checks"."bonus_gold_delta" >= 0),
  CONSTRAINT "rt2_v33_quality_checks_penalty_gold_delta_check" CHECK ("rt2_v33_quality_checks"."penalty_gold_delta" <= 0),
  CONSTRAINT "rt2_v33_quality_checks_applied_gold_delta_check" CHECK ("rt2_v33_quality_checks"."applied_gold_delta" >= 0),
  CONSTRAINT "rt2_v33_quality_checks_shadow_penalty_apply_check" CHECK (("rt2_v33_quality_checks"."phase_mode" <> 'shadow' or "rt2_v33_quality_checks"."penalty_gold_delta" >= 0 or "rt2_v33_quality_checks"."applied_gold_delta" = 0))
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_todo_issue_id_issues_id_fk" FOREIGN KEY ("todo_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_quality_checks" ADD CONSTRAINT "rt2_v33_quality_checks_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rt2_v33_quality_checks_company_work_product_created_idx" ON "rt2_v33_quality_checks" USING btree ("company_id","work_product_id","created_at");
