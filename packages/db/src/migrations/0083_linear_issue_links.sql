-- Phase 2 of the Linear ↔ Paperclip ID Unification plan.
-- See onprem-k8s commit 9979d0d / .planning/linear-id-unification.md.
--
-- One row per (paperclip issue, Linear issue) pair. The dedicated table
-- (rather than overloading the existing plugin_entities) buys ON DELETE
-- CASCADE from issues — at the tens-of-thousands-of-issues scale this is
-- sized for, orphan rows from issue deletes would accumulate without it.
CREATE TABLE "linear_issue_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "paperclip_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "linear_issue_id" text NOT NULL,
  "linear_identifier" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_links_paperclip_issue_idx"
  ON "linear_issue_links" ("paperclip_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_links_company_linear_identifier_idx"
  ON "linear_issue_links" ("company_id", "linear_identifier");
