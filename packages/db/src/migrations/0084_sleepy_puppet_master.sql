CREATE TABLE "betting_bankroll_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"balance" double precision NOT NULL,
	"currency" text DEFAULT 'RON' NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_bets" integer DEFAULT 0 NOT NULL,
	"won_bets" integer DEFAULT 0 NOT NULL,
	"lost_bets" integer DEFAULT 0 NOT NULL,
	"void_bets" integer DEFAULT 0 NOT NULL,
	"total_staked" double precision DEFAULT 0 NOT NULL,
	"total_return" double precision DEFAULT 0 NOT NULL,
	"roi" double precision
);
--> statement-breakpoint
CREATE TABLE "betting_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"external_id" text,
	"sport" text NOT NULL,
	"league" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"odds_json" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "betting_placed_bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"prediction_id" uuid,
	"bookmaker" text NOT NULL,
	"odds" double precision NOT NULL,
	"stake" double precision NOT NULL,
	"currency" text DEFAULT 'RON' NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"execution_status" text NOT NULL,
	"execution_ledger" jsonb,
	"profit_loss" double precision,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "betting_placed_bets_idempotency_key_uniq" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "betting_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"agent_id" uuid,
	"prediction" text NOT NULL,
	"confidence" double precision NOT NULL,
	"expected_value" double precision,
	"target_odds" double precision,
	"reasoning" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "betting_bankroll_snapshots" ADD CONSTRAINT "betting_bankroll_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "betting_matches" ADD CONSTRAINT "betting_matches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "betting_placed_bets" ADD CONSTRAINT "betting_placed_bets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "betting_placed_bets" ADD CONSTRAINT "betting_placed_bets_prediction_id_betting_predictions_id_fk" FOREIGN KEY ("prediction_id") REFERENCES "public"."betting_predictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "betting_predictions" ADD CONSTRAINT "betting_predictions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "betting_predictions" ADD CONSTRAINT "betting_predictions_match_id_betting_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."betting_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "betting_predictions" ADD CONSTRAINT "betting_predictions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "betting_bankroll_snapshots_company_snapshot_at_idx" ON "betting_bankroll_snapshots" USING btree ("company_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "betting_matches_company_starts_at_idx" ON "betting_matches" USING btree ("company_id","starts_at");--> statement-breakpoint
CREATE INDEX "betting_matches_external_id_idx" ON "betting_matches" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "betting_placed_bets_company_placed_at_idx" ON "betting_placed_bets" USING btree ("company_id","placed_at");--> statement-breakpoint
CREATE INDEX "betting_predictions_company_created_idx" ON "betting_predictions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "betting_predictions_match_idx" ON "betting_predictions" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);