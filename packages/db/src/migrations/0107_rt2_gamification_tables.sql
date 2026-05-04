CREATE TABLE "rt2_gamification_xp_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"activity_type" text NOT NULL,
	"xp_amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_gamification_level_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"level_before" integer NOT NULL,
	"level_after" integer NOT NULL,
	"xp_at_change" integer NOT NULL,
	"trigger" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_gamification_achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"achievement_key" text NOT NULL,
	"scope" text DEFAULT 'agent' NOT NULL,
	"earned_at" timestamp with time zone,
	"metadata_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_gamification_agent_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"lifetime_earned" integer DEFAULT 0 NOT NULL,
	"lifetime_spent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_gamification_xp_transactions" ADD CONSTRAINT "rt2_gamification_xp_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_xp_transactions" ADD CONSTRAINT "rt2_gamification_xp_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_xp_transactions" ADD CONSTRAINT "rt2_gamification_xp_transactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_level_history" ADD CONSTRAINT "rt2_gamification_level_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_level_history" ADD CONSTRAINT "rt2_gamification_level_history_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_achievements" ADD CONSTRAINT "rt2_gamification_achievements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_achievements" ADD CONSTRAINT "rt2_gamification_achievements_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_agent_balances" ADD CONSTRAINT "rt2_gamification_agent_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_gamification_agent_balances" ADD CONSTRAINT "rt2_gamification_agent_balances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "xp_transactions_company_agent_idx" ON "rt2_gamification_xp_transactions" USING btree ("company_id","agent_id");
--> statement-breakpoint
CREATE INDEX "xp_transactions_company_activity_idx" ON "rt2_gamification_xp_transactions" USING btree ("company_id","activity_type");
--> statement-breakpoint
CREATE INDEX "xp_transactions_company_created_idx" ON "rt2_gamification_xp_transactions" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "level_history_company_agent_idx" ON "rt2_gamification_level_history" USING btree ("company_id","agent_id");
--> statement-breakpoint
CREATE INDEX "level_history_company_created_idx" ON "rt2_gamification_level_history" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "achievements_company_agent_key_idx" ON "rt2_gamification_achievements" USING btree ("company_id","agent_id","achievement_key");
--> statement-breakpoint
CREATE INDEX "achievements_company_scope_idx" ON "rt2_gamification_achievements" USING btree ("company_id","scope");
--> statement-breakpoint
CREATE INDEX "agent_balances_company_agent_idx" ON "rt2_gamification_agent_balances" USING btree ("company_id","agent_id");
--> statement-breakpoint
CREATE INDEX "agent_balances_company_balance_idx" ON "rt2_gamification_agent_balances" USING btree ("company_id","balance");
