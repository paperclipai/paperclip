CREATE TABLE "issue_import_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "manifest_version" integer NOT NULL,
  "manifest_digest" text NOT NULL,
  "source_snapshot_version" text NOT NULL,
  "source_snapshot_retrieved_at" timestamptz NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "actor_run_id" uuid,
  "status" text DEFAULT 'preview_ready' NOT NULL,
  "received_count" integer DEFAULT 0 NOT NULL,
  "created_count" integer DEFAULT 0 NOT NULL,
  "linked_count" integer DEFAULT 0 NOT NULL,
  "updated_count" integer DEFAULT 0 NOT NULL,
  "unchanged_count" integer DEFAULT 0 NOT NULL,
  "conflict_count" integer DEFAULT 0 NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "relation_count" integer DEFAULT 0 NOT NULL,
  "comment_created_count" integer DEFAULT 0 NOT NULL,
  "comment_deduplicated_count" integer DEFAULT 0 NOT NULL,
  "assignment_count" integer DEFAULT 0 NOT NULL,
  "wake_count" integer DEFAULT 0 NOT NULL,
  "error_summary" text,
  "expires_at" timestamptz NOT NULL,
  "applied_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "issue_import_runs_company_created_idx" ON "issue_import_runs" ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX "issue_import_runs_company_digest_idx" ON "issue_import_runs" ("company_id", "manifest_digest");
--> statement-breakpoint
CREATE TABLE "issue_import_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "issue_import_runs"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "item_index" integer NOT NULL,
  "source_id" text NOT NULL,
  "source_identifier" text NOT NULL,
  "source_version" text NOT NULL,
  "source_updated_at" timestamptz NOT NULL,
  "source_url" text NOT NULL,
  "action" text NOT NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "source_data" jsonb NOT NULL,
  "proposed" jsonb NOT NULL,
  "current" jsonb,
  "applied" jsonb,
  "conflicts" jsonb NOT NULL,
  "failures" jsonb NOT NULL,
  "relation_results" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_import_items_run_source_uq" ON "issue_import_items" ("run_id", "source_id");
--> statement-breakpoint
CREATE INDEX "issue_import_items_company_source_idx" ON "issue_import_items" ("company_id", "provider", "source_id");
--> statement-breakpoint
CREATE TABLE "issue_origin_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "source_id" text NOT NULL,
  "source_identifier" text NOT NULL,
  "source_version" text NOT NULL,
  "source_updated_at" timestamptz NOT NULL,
  "source_url" text NOT NULL,
  "last_reconciled_run_id" uuid NOT NULL REFERENCES "issue_import_runs"("id"),
  "state" text DEFAULT 'staged' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_origin_states_company_provider_source_uq" ON "issue_origin_states" ("company_id", "provider", "source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_origin_states_issue_provider_uq" ON "issue_origin_states" ("issue_id", "provider");
--> statement-breakpoint
CREATE TABLE "provider_event_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "source_event_id" text NOT NULL,
  "source_comment_id" text NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "issue_comment_id" uuid REFERENCES "issue_comments"("id") ON DELETE SET NULL,
  "import_run_id" uuid NOT NULL REFERENCES "issue_import_runs"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_event_receipts_company_provider_event_uq" ON "provider_event_receipts" ("company_id", "provider", "source_event_id", "source_comment_id");
--> statement-breakpoint
CREATE INDEX "provider_event_receipts_issue_idx" ON "provider_event_receipts" ("issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issues_linear_origin_uq" ON "issues" ("company_id", "origin_kind", "origin_id") WHERE "origin_kind" = 'linear_issue' AND "origin_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_linear_issue_origin_mutation() RETURNS trigger AS $$
BEGIN
  IF (OLD.origin_kind = 'linear_issue' OR NEW.origin_kind = 'linear_issue') AND (
    NEW.origin_kind IS DISTINCT FROM OLD.origin_kind OR
    NEW.origin_id IS DISTINCT FROM OLD.origin_id OR
    NEW.origin_fingerprint IS DISTINCT FROM OLD.origin_fingerprint
  ) THEN
    RAISE EXCEPTION 'Linear issue origin linkage is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "issues_linear_origin_immutable"
BEFORE UPDATE OF "origin_kind", "origin_id", "origin_fingerprint" ON "issues"
FOR EACH ROW EXECUTE FUNCTION prevent_linear_issue_origin_mutation();
