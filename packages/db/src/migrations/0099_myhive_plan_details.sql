CREATE TABLE IF NOT EXISTS "plan_details" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_cap_cents" integer,
	"budget_cap_tokens" bigint,
	"activated_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "plan_root_issue_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_details" ADD CONSTRAINT "plan_details_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_details" ADD CONSTRAINT "plan_details_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_details" ADD CONSTRAINT "plan_details_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_plan_root_issue_id_issues_id_fk" FOREIGN KEY ("plan_root_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_details_company_state_idx" ON "plan_details" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_plan_root_idx" ON "issues" USING btree ("company_id","plan_root_issue_id");--> statement-breakpoint
-- Backfill plan_root_issue_id for descendants of existing planning-mode issues.
WITH RECURSIVE plan_roots AS (
	SELECT "id", "id" AS root_id
	FROM "issues"
	WHERE "work_mode" = 'planning'
	UNION ALL
	SELECT c."id", pr.root_id
	FROM "issues" c
	INNER JOIN plan_roots pr ON c."parent_id" = pr."id"
)
UPDATE "issues" i
SET "plan_root_issue_id" = pr.root_id
FROM plan_roots pr
WHERE i."id" = pr."id" AND pr.root_id <> i."id";
