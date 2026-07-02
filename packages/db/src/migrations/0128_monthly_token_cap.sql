ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "monthly_token_cap_tokens" bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_cap_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "month" date NOT NULL,
  "offset_tokens" bigint NOT NULL,
  "reset_at" timestamp with time zone NOT NULL,
  "authorized_by_user_id" text,
  "authorized_by_agent_id" uuid,
  "recover_issue_id" uuid,
  CONSTRAINT "token_cap_resets_exactly_one_authorized_by" CHECK (("authorized_by_user_id" IS NOT NULL)::int + ("authorized_by_agent_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_cap_warnings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "month" date NOT NULL,
  "sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "token_cap_resets"
    ADD CONSTRAINT "token_cap_resets_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "token_cap_resets"
    ADD CONSTRAINT "token_cap_resets_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "token_cap_resets"
    ADD CONSTRAINT "token_cap_resets_authorized_by_agent_id_agents_id_fk"
    FOREIGN KEY ("authorized_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "token_cap_resets"
    ADD CONSTRAINT "token_cap_resets_recover_issue_id_issues_id_fk"
    FOREIGN KEY ("recover_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "token_cap_warnings"
    ADD CONSTRAINT "token_cap_warnings_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "token_cap_warnings"
    ADD CONSTRAINT "token_cap_warnings_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_cap_resets_company_agent_month_idx"
  ON "token_cap_resets" USING btree ("company_id", "agent_id", "month");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "token_cap_warnings_agent_month_uniq"
  ON "token_cap_warnings" USING btree ("agent_id", "month");
