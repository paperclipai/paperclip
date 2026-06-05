-- Merged-PR ↔ issue linkage for the fleet $/merged-output metric
-- (BLO-9117 / BLO-9102 Diff 2). See packages/db/src/schema/issue_pull_requests.ts.
--
-- Hand-authored tail migration (the drizzle journal is intentionally stale at
-- 0102; 0103/0104/0105 are also hand-authored). Do NOT run drizzle-kit generate.
-- The apply path wraps each statement in a SAVEPOINT and swallows
-- duplicate-object errors, so IF NOT EXISTS + the FK guards make this re-apply-safe.
--
-- NOTE: there is deliberately no pr_author column. The link key is the BLO- ref
-- (link_source), never the PR author — an author column cannot be reintroduced
-- as a filter if it does not exist (the BLO-9103 identity-bucket drop guard).
CREATE TABLE IF NOT EXISTS "issue_pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid,
  "repo_full_name" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text,
  "merged_at" timestamp with time zone,
  "additions" integer,
  "deletions" integer,
  "authored_additions" integer,
  "authored_deletions" integer,
  "excluded_paths" jsonb,
  "link_source" text,
  "paperclip_identifier" text,
  "loc_enriched_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_pull_requests"
    ADD CONSTRAINT "issue_pull_requests_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_pull_requests"
    ADD CONSTRAINT "issue_pull_requests_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "issues"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_pull_requests_repo_pr_unique"
  ON "issue_pull_requests" USING btree ("company_id", "repo_full_name", "pr_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_pull_requests_company_issue_idx"
  ON "issue_pull_requests" USING btree ("company_id", "issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_pull_requests_company_merged_idx"
  ON "issue_pull_requests" USING btree ("company_id", "merged_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_pull_requests_enrich_pending_idx"
  ON "issue_pull_requests" USING btree ("loc_enriched_at");
