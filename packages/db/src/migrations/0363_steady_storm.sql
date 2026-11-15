-- Earlier feature checkouts may already have applied the original 0355 case
-- foundation. Its table and routing changes committed atomically, so retain that
-- existing schema and history instead of replaying CREATE/ADD statements.
DO $case_foundation$
BEGIN
  IF to_regclass('public.case_handoffs') IS NULL THEN
CREATE TABLE "case_access_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_access_sources_kind_check" CHECK ("case_access_sources"."source_kind" in ('issue', 'project'))
);

CREATE TABLE "case_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"from_agent_id" uuid,
	"to_agent_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"instructions" text NOT NULL,
	"comment_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"source_run_id" uuid,
	"responsible_user_id" text,
	"expected_issue_status_version" bigint,
	"applied_issue_status_version" bigint,
	"wakeup_request_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignment_applied_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_handoffs_state_check" CHECK ("case_handoffs"."state" in ('awaiting_release', 'pending_dispatch', 'delivered', 'cancelled')),
	CONSTRAINT "case_handoffs_actor_type_check" CHECK ("case_handoffs"."actor_type" in ('agent', 'user', 'system'))
);

ALTER TABLE "case_events" DROP CONSTRAINT IF EXISTS "case_events_kind_check";
ALTER TABLE "cases" ADD COLUMN "work_issue_id" uuid;
ALTER TABLE "cases" ADD COLUMN "phase" text;
ALTER TABLE "cases" ADD COLUMN "handoff_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "case_access_sources" ADD CONSTRAINT "case_access_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "case_access_sources" ADD CONSTRAINT "case_access_sources_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "case_access_sources_case_source_uq" ON "case_access_sources" USING btree ("case_id","source_kind","source_id");
CREATE INDEX "case_access_sources_company_case_idx" ON "case_access_sources" USING btree ("company_id","case_id");
CREATE UNIQUE INDEX "case_handoffs_case_version_uq" ON "case_handoffs" USING btree ("company_id","case_id","version");
CREATE UNIQUE INDEX "case_handoffs_actor_idempotency_uq" ON "case_handoffs" USING btree ("company_id","actor_type","actor_id","idempotency_key");
CREATE UNIQUE INDEX "case_handoffs_pending_case_uq" ON "case_handoffs" USING btree ("case_id") WHERE "case_handoffs"."state" in ('awaiting_release', 'pending_dispatch');
CREATE UNIQUE INDEX "case_handoffs_pending_issue_uq" ON "case_handoffs" USING btree ("issue_id") WHERE "case_handoffs"."state" in ('awaiting_release', 'pending_dispatch');
CREATE INDEX "case_handoffs_pending_attempt_idx" ON "case_handoffs" USING btree ("next_attempt_at") WHERE "case_handoffs"."state" in ('awaiting_release', 'pending_dispatch');
CREATE INDEX "case_handoffs_case_created_idx" ON "case_handoffs" USING btree ("case_id","created_at");
ALTER TABLE "cases" ADD CONSTRAINT "cases_work_issue_id_issues_id_fk" FOREIGN KEY ("work_issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "cases_work_issue_uq" ON "cases" USING btree ("work_issue_id") WHERE "cases"."work_issue_id" is not null;
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
        'created',
        'updated',
        'fields_changed',
        'status_changed',
        'issue_linked',
        'issue_unlinked',
        'document_revised',
        'child_linked',
        'attachment_added',
        'label_added',
        'label_removed',
        'handoff_requested',
        'handoff_applied',
        'handoff_delivered',
        'handoff_cancelled'
      ));
-- Preserve every historical source boundary. Logical source IDs deliberately
-- survive source deletion so removing a task/project cannot publish a case.
INSERT INTO "case_access_sources" ("company_id", "case_id", "source_kind", "source_id")
SELECT "company_id", "id", 'project', "project_id" FROM "cases" WHERE "project_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "case_access_sources" ("company_id", "case_id", "source_kind", "source_id")
SELECT "company_id", "case_id", 'issue', "issue_id" FROM "case_issue_links"
ON CONFLICT DO NOTHING;

  END IF;
END
$case_foundation$;
