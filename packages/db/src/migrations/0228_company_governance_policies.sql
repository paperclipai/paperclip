CREATE TABLE "company_governance_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "active_revision_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "company_governance_policies_company_unique" ON "company_governance_policies" USING btree ("company_id");
--> statement-breakpoint
CREATE TABLE "company_governance_policy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "policy_id" uuid NOT NULL REFERENCES "company_governance_policies"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "body" text NOT NULL,
  "bindings" jsonb NOT NULL,
  "sha256" text NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "company_governance_policy_revisions_policy_revision_unique" ON "company_governance_policy_revisions" USING btree ("policy_id","revision");
--> statement-breakpoint
WITH created_policies AS (
  INSERT INTO "company_governance_policies" ("id", "company_id")
  SELECT gen_random_uuid(), "id"
  FROM "companies"
  ON CONFLICT ("company_id") DO NOTHING
  RETURNING "id", "company_id"
), created_revisions AS (
  INSERT INTO "company_governance_policy_revisions" (
    "id", "company_id", "policy_id", "revision", "schema_version", "body", "bindings", "sha256"
  )
  SELECT
    gen_random_uuid(),
    "company_id",
    "id",
    1,
    1,
    $policy$# Company governance policy

- Keep one machine-visible next path: a live or queued run, assigned todo, real blocker, active review, or done with evidence.
- Route work to the responsible role. Do not assign technical, QA, recovery, or operational work to the founder; use a single explicit interaction only for a non-delegable founder decision.
- After two equivalent scope-mismatch outcomes, do not start a third run for the same executor; route to CTO/QA or create one non-duplicating corrective issue.
- Before validation record original scope, changed surfaces, affected contracts, blocking tests, diagnostic tests, external failures, and dependency decision. Review comments must include validation_scope.
- Every substantive review uses gpt-5.6-luna with fastMode=false and reasoningEffort=medium; reviewer records a machine decision before CTO approval.
- Before reopening a done or blocked issue validate its execution workspace. Clear stale workspace linkage through the API; never recreate a vanished worktree or erase changes to mask a problem.
- Send text JSON from Windows PowerShell as UTF-8 bytes with application/json; charset=utf-8, then read it back and compare it. A mismatch or four question marks is a failed mutation.
- Never set done manually to mask infrastructure, recovery, encoding, sandbox, setup, or cleanup failures.
$policy$,
    $json$[{"id":"all-codex-heartbeats","priority":100,"effect":"include","subject":{"type":"all_agents"},"scopes":["heartbeat"],"adapterTypes":["codex_local","paperclip_runner"],"delivery":"required"}]$json$::jsonb,
    'fda8127cc899c459594052ab1d89282daa88f923010c655b2738f8d600e3623f'
  FROM created_policies
  RETURNING "id", "policy_id"
)
UPDATE "company_governance_policies" AS policy
SET "active_revision_id" = revision."id", "updated_at" = now()
FROM created_revisions AS revision
WHERE policy."id" = revision."policy_id";
