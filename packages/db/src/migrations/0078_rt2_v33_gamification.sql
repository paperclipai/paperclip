CREATE TABLE "rt2_v33_coin_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"task_issue_id" uuid NOT NULL,
	"awarded_by_user_id" text NOT NULL,
	"entry_kind" text DEFAULT 'task_completion' NOT NULL,
	"phase_mode" text DEFAULT 'shadow' NOT NULL,
	"settlement_state" text DEFAULT 'proposed' NOT NULL,
	"gold_delta" integer NOT NULL,
	"xp_delta" integer NOT NULL,
	"formula_version" text DEFAULT 'm2.2.v1' NOT NULL,
	"rationale" text NOT NULL,
	"decision_note" text,
	"evidence_tag" text DEFAULT 'EXTRACTED' NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_coin_ledger_entry_kind_check" CHECK ("rt2_v33_coin_ledger"."entry_kind" in ('task_completion', 'manual_award', 'manual_reversal')),
	CONSTRAINT "rt2_v33_coin_ledger_phase_mode_check" CHECK ("rt2_v33_coin_ledger"."phase_mode" in ('shadow', 'co_pilot', 'auto')),
	CONSTRAINT "rt2_v33_coin_ledger_settlement_state_check" CHECK ("rt2_v33_coin_ledger"."settlement_state" in ('proposed', 'issued')),
	CONSTRAINT "rt2_v33_coin_ledger_gold_delta_check" CHECK ((("rt2_v33_coin_ledger"."entry_kind" in ('task_completion', 'manual_award') and "rt2_v33_coin_ledger"."gold_delta" >= 0) or ("rt2_v33_coin_ledger"."entry_kind" = 'manual_reversal' and "rt2_v33_coin_ledger"."gold_delta" <= 0))),
	CONSTRAINT "rt2_v33_coin_ledger_xp_delta_check" CHECK ((("rt2_v33_coin_ledger"."entry_kind" in ('task_completion', 'manual_award') and "rt2_v33_coin_ledger"."xp_delta" >= 0) or ("rt2_v33_coin_ledger"."entry_kind" = 'manual_reversal' and "rt2_v33_coin_ledger"."xp_delta" <= 0)))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_skill_trees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"phase_mode" text DEFAULT 'shadow' NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp_total" integer DEFAULT 0 NOT NULL,
	"gold_balance" integer DEFAULT 0 NOT NULL,
	"streak_days" integer DEFAULT 0 NOT NULL,
	"longest_streak_days" integer DEFAULT 0 NOT NULL,
	"unlocked_node_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_awarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_skill_trees_phase_mode_check" CHECK ("rt2_v33_skill_trees"."phase_mode" in ('shadow', 'co_pilot', 'auto')),
	CONSTRAINT "rt2_v33_skill_trees_level_check" CHECK ("rt2_v33_skill_trees"."level" >= 1 and "rt2_v33_skill_trees"."level" <= 10),
	CONSTRAINT "rt2_v33_skill_trees_xp_total_check" CHECK ("rt2_v33_skill_trees"."xp_total" >= 0),
	CONSTRAINT "rt2_v33_skill_trees_gold_balance_check" CHECK ("rt2_v33_skill_trees"."gold_balance" >= 0),
	CONSTRAINT "rt2_v33_skill_trees_streak_days_check" CHECK ("rt2_v33_skill_trees"."streak_days" >= 0),
	CONSTRAINT "rt2_v33_skill_trees_longest_streak_days_check" CHECK ("rt2_v33_skill_trees"."longest_streak_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_coin_ledger" ADD CONSTRAINT "rt2_v33_coin_ledger_awarded_by_user_id_user_id_fk" FOREIGN KEY ("awarded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_skill_trees" ADD CONSTRAINT "rt2_v33_skill_trees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_skill_trees" ADD CONSTRAINT "rt2_v33_skill_trees_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_coin_ledger_company_task_user_settlement_uq" ON "rt2_v33_coin_ledger" USING btree ("company_id","task_issue_id","user_id","entry_kind","settlement_state");
--> statement-breakpoint
CREATE INDEX "rt2_v33_coin_ledger_company_project_created_idx" ON "rt2_v33_coin_ledger" USING btree ("company_id","project_id","created_at");
--> statement-breakpoint
CREATE INDEX "rt2_v33_coin_ledger_company_user_created_idx" ON "rt2_v33_coin_ledger" USING btree ("company_id","user_id","created_at");
--> statement-breakpoint
CREATE RULE "rt2_v33_coin_ledger_no_update" AS
    ON UPDATE TO "rt2_v33_coin_ledger"
    DO INSTEAD NOTHING;
--> statement-breakpoint
CREATE RULE "rt2_v33_coin_ledger_no_delete" AS
    ON DELETE TO "rt2_v33_coin_ledger"
    DO INSTEAD NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_skill_trees_company_user_uq" ON "rt2_v33_skill_trees" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX "rt2_v33_skill_trees_company_level_idx" ON "rt2_v33_skill_trees" USING btree ("company_id","level","xp_total");
