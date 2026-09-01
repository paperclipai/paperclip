CREATE TABLE "formal_qa_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"required_workflow_id" text NOT NULL,
	"required_check_name" text NOT NULL,
	"required_check_app_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formal_qa_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"issuance_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"wakeup_request_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"tree_sha" text NOT NULL,
	"issuance_sha256" text NOT NULL,
	"checkout_sha256" text NOT NULL,
	"contract_sha256" text NOT NULL,
	"reviewer_config_sha256" text NOT NULL,
	"prompt_sha256" text NOT NULL,
	"source_snapshot_json" text NOT NULL,
	"source_snapshot_sha256" text NOT NULL,
	"source_manifest_json" text NOT NULL,
	"source_manifest_sha256" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"decision" text,
	"decision_artifact" jsonb,
	"decision_sha256" text,
	"terminal_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "policy_id" uuid;--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "policy_version" integer;--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "required_check_app_id" integer;--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "check_suite_id" text;--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "workflow_id" text;--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD COLUMN "evidence_json" text;--> statement-breakpoint
ALTER TABLE "formal_qa_policies" ADD CONSTRAINT "formal_qa_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_policies" ADD CONSTRAINT "formal_qa_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_policies" ADD CONSTRAINT "formal_qa_policies_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_policies" ADD CONSTRAINT "formal_qa_policies_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_preparation_id_formal_qa_preparations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."formal_qa_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_issuance_id_formal_qa_issuances_id_fk" FOREIGN KEY ("issuance_id") REFERENCES "public"."formal_qa_issuances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_checkout_id_formal_qa_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."formal_qa_checkouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_policy_id_formal_qa_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."formal_qa_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formal_qa_reviews" ADD CONSTRAINT "formal_qa_reviews_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_policies_workspace_uq" ON "formal_qa_policies" USING btree ("project_workspace_id");--> statement-breakpoint
CREATE INDEX "formal_qa_policies_company_project_idx" ON "formal_qa_policies" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_reviews_checkout_uq" ON "formal_qa_reviews" USING btree ("checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_reviews_issuance_uq" ON "formal_qa_reviews" USING btree ("issuance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_reviews_heartbeat_run_uq" ON "formal_qa_reviews" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_reviews_wakeup_request_uq" ON "formal_qa_reviews" USING btree ("wakeup_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_reviews_execution_workspace_uq" ON "formal_qa_reviews" USING btree ("execution_workspace_id");--> statement-breakpoint
CREATE INDEX "formal_qa_reviews_company_status_created_idx" ON "formal_qa_reviews" USING btree ("company_id","status","created_at");--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" ADD CONSTRAINT "formal_qa_issuances_policy_id_formal_qa_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."formal_qa_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_issuances_semantic_uq" ON "formal_qa_issuances" USING btree ("company_id","policy_id","repository","pr_number","head_sha");--> statement-breakpoint
ALTER TABLE "formal_qa_issuances" DROP COLUMN "required_check_app_slug";--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version < 1 OR NEW.repository !~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$' THEN
    RAISE EXCEPTION 'formal_qa_policy_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM projects p
    JOIN project_workspaces w ON w.id = NEW.project_workspace_id
    JOIN agents a ON a.id = NEW.reviewer_agent_id
    WHERE p.id = NEW.project_id AND p.company_id = NEW.company_id
      AND w.company_id = NEW.company_id AND w.project_id = NEW.project_id
      AND a.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'formal_qa_policy_scope_mismatch';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'formal_qa_policy_initial_version_invalid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.project_workspace_id IS DISTINCT FROM OLD.project_workspace_id
      OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.version <> OLD.version + 1
      OR NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION 'formal_qa_policy_version_transition_invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER formal_qa_policy_guard_trigger
BEFORE INSERT OR UPDATE ON formal_qa_policies
FOR EACH ROW EXECUTE FUNCTION formal_qa_policy_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_issuance_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'formal_qa_issuance_immutable';
  END IF;
  IF NEW.policy_id IS NULL OR NEW.policy_version IS NULL OR NEW.required_check_app_id IS NULL
    OR NEW.check_suite_id IS NULL OR NEW.workflow_run_id IS NULL OR NEW.workflow_id IS NULL
    OR NEW.evidence_json IS NULL OR NEW.snapshot_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'formal_qa_issuance_evidence_incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM formal_qa_preparations p
    JOIN formal_qa_policies q ON q.id = NEW.policy_id
    WHERE p.id = NEW.preparation_id AND p.status = 'issued' AND p.expires_at > now()
      AND p.company_id = NEW.company_id AND p.project_id = NEW.project_id
      AND p.project_workspace_id = NEW.project_workspace_id
      AND p.repository = NEW.repository AND p.pr_number::text = NEW.pr_number
      AND p.head_sha = NEW.head_sha AND p.base_ref = NEW.base_ref
      AND p.base_sha = NEW.base_sha AND p.tree_sha = NEW.tree_sha
      AND q.enabled = true AND q.version = NEW.policy_version
      AND q.company_id = NEW.company_id AND q.project_id = NEW.project_id
      AND q.project_workspace_id = NEW.project_workspace_id
      AND q.repository = NEW.repository
      AND q.required_check_name = NEW.required_check_name
      AND q.required_check_app_id = NEW.required_check_app_id
      AND q.required_workflow_id = NEW.workflow_id
  ) THEN
    RAISE EXCEPTION 'formal_qa_issuance_authority_mismatch';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER formal_qa_issuance_guard_trigger
BEFORE INSERT OR UPDATE ON formal_qa_issuances
FOR EACH ROW EXECUTE FUNCTION formal_qa_issuance_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_checkout_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'creating' OR NEW.checkout_sha256 !~ '^[0-9a-f]{64}$'
      OR NOT EXISTS (
        SELECT 1 FROM formal_qa_preparations p
        JOIN formal_qa_issuances i ON i.preparation_id = p.id
        WHERE p.id = NEW.preparation_id AND p.status = 'issued' AND p.expires_at > now()
          AND p.company_id = NEW.company_id AND p.project_id = NEW.project_id
          AND p.project_workspace_id = NEW.project_workspace_id
          AND p.repository = NEW.repository AND p.head_sha = NEW.head_sha AND p.tree_sha = NEW.tree_sha
          AND i.policy_id IS NOT NULL
      ) THEN
      RAISE EXCEPTION 'formal_qa_checkout_authority_mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'creating' THEN
    RAISE EXCEPTION 'formal_qa_checkout_immutable';
  END IF;
  IF NEW.status <> 'verified'
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.preparation_id IS DISTINCT FROM OLD.preparation_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.project_workspace_id IS DISTINCT FROM OLD.project_workspace_id
    OR NEW.repository IS DISTINCT FROM OLD.repository OR NEW.repo_root IS DISTINCT FROM OLD.repo_root
    OR NEW.checkout_path IS DISTINCT FROM OLD.checkout_path OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
    OR NEW.tree_sha IS DISTINCT FROM OLD.tree_sha OR NEW.checkout_sha256 IS DISTINCT FROM OLD.checkout_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'formal_qa_checkout_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER formal_qa_checkout_guard_trigger
BEFORE INSERT OR UPDATE ON formal_qa_checkouts
FOR EACH ROW EXECUTE FUNCTION formal_qa_checkout_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_review_has_live_authority(candidate formal_qa_reviews)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM formal_qa_preparations p
    JOIN formal_qa_issuances i ON i.id = candidate.issuance_id AND i.preparation_id = p.id
    JOIN formal_qa_checkouts c ON c.id = candidate.checkout_id AND c.preparation_id = p.id
    JOIN formal_qa_policies q ON q.id = candidate.policy_id
    JOIN agents a ON a.id = candidate.reviewer_agent_id
    WHERE p.id = candidate.preparation_id AND p.status = 'issued'
      AND p.expires_at = candidate.expires_at AND p.expires_at > clock_timestamp()
      AND p.company_id = candidate.company_id AND p.project_id = candidate.project_id
      AND p.project_workspace_id = candidate.project_workspace_id
      AND p.repository = candidate.repository AND p.pr_number = candidate.pr_number
      AND p.head_sha = candidate.head_sha AND p.tree_sha = candidate.tree_sha
      AND i.company_id = candidate.company_id AND i.project_id = candidate.project_id
      AND i.project_workspace_id = candidate.project_workspace_id
      AND i.policy_id = candidate.policy_id AND i.policy_version = candidate.policy_version
      AND i.repository = candidate.repository AND i.pr_number = candidate.pr_number::text
      AND i.head_sha = candidate.head_sha AND i.tree_sha = candidate.tree_sha
      AND i.snapshot_sha256 = candidate.issuance_sha256
      AND c.company_id = candidate.company_id AND c.project_id = candidate.project_id
      AND c.project_workspace_id = candidate.project_workspace_id
      AND c.repository = candidate.repository AND c.head_sha = candidate.head_sha
      AND c.tree_sha = candidate.tree_sha AND c.checkout_sha256 = candidate.checkout_sha256
      AND c.status = 'verified'
      AND q.enabled = true AND q.version = candidate.policy_version
      AND q.company_id = candidate.company_id AND q.project_id = candidate.project_id
      AND q.project_workspace_id = candidate.project_workspace_id
      AND q.repository = candidate.repository AND q.reviewer_agent_id = candidate.reviewer_agent_id
      AND a.company_id = candidate.company_id AND a.adapter_type = 'codex_local'
      AND candidate.reviewer_config_sha256 = encode(sha256(convert_to(jsonb_build_object(
        'adapterType', a.adapter_type,
        'adapterConfig', a.adapter_config,
        'runtimeConfig', a.runtime_config
      )::text, 'UTF8')), 'hex')
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_review_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.decision IS NOT NULL OR NEW.decision_artifact IS NOT NULL
      OR NEW.decision_sha256 IS NOT NULL OR NEW.terminal_reason IS NOT NULL
      OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
      OR NEW.issuance_sha256 !~ '^[0-9a-f]{64}$' OR NEW.checkout_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.contract_sha256 !~ '^[0-9a-f]{64}$' OR NEW.reviewer_config_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.prompt_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.source_snapshot_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.source_snapshot_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.source_snapshot_json, 'UTF8')), 'hex')
      OR NEW.source_manifest_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.source_manifest_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.source_manifest_json, 'UTF8')), 'hex')
      OR NEW.source_snapshot_json::jsonb IS DISTINCT FROM jsonb_build_object(
        'schema', 'paperclip.formal-qa-review-source/v1',
        'preparationId', NEW.preparation_id::text,
        'issuanceId', NEW.issuance_id::text,
        'checkoutId', NEW.checkout_id::text,
        'policyId', NEW.policy_id::text,
        'policyVersion', NEW.policy_version,
        'reviewerAgentId', NEW.reviewer_agent_id::text,
        'repository', NEW.repository,
        'prNumber', NEW.pr_number,
        'headSha', NEW.head_sha,
        'baseRef', (SELECT base_ref FROM formal_qa_preparations WHERE id = NEW.preparation_id),
        'baseSha', (SELECT base_sha FROM formal_qa_preparations WHERE id = NEW.preparation_id),
        'treeSha', NEW.tree_sha,
        'checkoutPath', (SELECT checkout_path FROM formal_qa_checkouts WHERE id = NEW.checkout_id),
        'issuanceSha256', NEW.issuance_sha256,
        'checkoutSha256', NEW.checkout_sha256,
        'contractSha256', NEW.contract_sha256,
        'reviewerConfigSha256', NEW.reviewer_config_sha256,
        'sourceManifestSha256', NEW.source_manifest_sha256
      )
      OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'formal_qa_review_initial_state_invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM formal_qa_preparations p
      JOIN formal_qa_issuances i ON i.id = NEW.issuance_id AND i.preparation_id = p.id
      JOIN formal_qa_checkouts c ON c.id = NEW.checkout_id AND c.preparation_id = p.id
      JOIN formal_qa_policies q ON q.id = NEW.policy_id
      JOIN agents a ON a.id = NEW.reviewer_agent_id
      JOIN execution_workspaces w ON w.id = NEW.execution_workspace_id
      JOIN agent_wakeup_requests u ON u.id = NEW.wakeup_request_id
      JOIN heartbeat_runs h ON h.id = NEW.heartbeat_run_id
      WHERE p.id = NEW.preparation_id AND p.status = 'issued' AND p.expires_at = NEW.expires_at
        AND p.company_id = NEW.company_id AND p.project_id = NEW.project_id
        AND p.project_workspace_id = NEW.project_workspace_id AND p.repository = NEW.repository
        AND p.pr_number = NEW.pr_number AND p.head_sha = NEW.head_sha AND p.tree_sha = NEW.tree_sha
        AND i.company_id = NEW.company_id AND i.project_id = NEW.project_id
        AND i.project_workspace_id = NEW.project_workspace_id AND i.policy_id = NEW.policy_id
        AND i.policy_version = NEW.policy_version AND i.repository = NEW.repository
        AND i.pr_number = NEW.pr_number::text AND i.head_sha = NEW.head_sha
        AND i.tree_sha = NEW.tree_sha AND i.snapshot_sha256 = NEW.issuance_sha256
        AND c.company_id = NEW.company_id AND c.project_id = NEW.project_id
        AND c.project_workspace_id = NEW.project_workspace_id AND c.repository = NEW.repository
        AND c.head_sha = NEW.head_sha AND c.tree_sha = NEW.tree_sha
        AND c.checkout_sha256 = NEW.checkout_sha256 AND c.status = 'verified'
        AND q.enabled = true AND q.version = NEW.policy_version
        AND q.company_id = NEW.company_id AND q.project_id = NEW.project_id
        AND q.project_workspace_id = NEW.project_workspace_id AND q.repository = NEW.repository
        AND q.reviewer_agent_id = NEW.reviewer_agent_id
        AND a.company_id = NEW.company_id AND a.adapter_type = 'codex_local'
        AND NEW.reviewer_config_sha256 = encode(sha256(convert_to(jsonb_build_object(
          'adapterType', a.adapter_type,
          'adapterConfig', a.adapter_config,
          'runtimeConfig', a.runtime_config
        )::text, 'UTF8')), 'hex')
        AND w.company_id = NEW.company_id AND w.project_id = NEW.project_id
        AND w.project_workspace_id = NEW.project_workspace_id AND w.source_issue_id IS NULL
        AND w.mode = 'formal_qa_checkout' AND w.strategy_type = 'formal_qa_checkout'
        AND w.status = 'active' AND w.cwd <> '' AND w.cwd = w.provider_ref AND w.provider_type = 'local_fs'
        AND w.base_ref = NEW.head_sha AND w.branch_name IS NULL
        AND w.metadata = jsonb_build_object(
          'schema', 'paperclip.formal-qa-execution-workspace/v1',
          'reviewId', NEW.id::text,
          'preparationId', NEW.preparation_id::text,
          'issuanceId', NEW.issuance_id::text,
          'checkoutId', NEW.checkout_id::text,
          'checkoutSha256', NEW.checkout_sha256,
          'contractSha256', NEW.contract_sha256,
          'reviewerConfigSha256', NEW.reviewer_config_sha256,
          'promptSha256', NEW.prompt_sha256,
          'sourceSnapshotSha256', NEW.source_snapshot_sha256,
          'sourceManifestSha256', NEW.source_manifest_sha256
        )
        AND u.company_id = NEW.company_id AND u.agent_id = NEW.reviewer_agent_id
        AND u.source = 'automation' AND u.trigger_detail = 'system'
        AND u.reason = 'formal_qa_review' AND u.status = 'queued'
        AND u.requested_by_actor_type = 'system' AND u.requested_by_actor_id = 'formal_qa_review_controller'
        AND u.idempotency_key = 'formal-qa-review:' || NEW.checkout_id::text
        AND u.run_id = NEW.heartbeat_run_id
        AND u.payload = jsonb_build_object('schema', 'paperclip.formal-qa-review-context/v1', 'formalQaReviewId', NEW.id::text)
        AND h.company_id = NEW.company_id AND h.agent_id = NEW.reviewer_agent_id
        AND h.invocation_source = 'automation' AND h.trigger_detail = 'system' AND h.status = 'queued'
        AND h.wakeup_request_id = NEW.wakeup_request_id AND h.runtime_mode = 'legacy'
        AND h.runtime_mode_resolver_version = 'formal-qa/v1' AND h.runtime_mode_reason = 'formal_qa_review'
        AND h.context_snapshot = jsonb_build_object('schema', 'paperclip.formal-qa-review-context/v1', 'formalQaReviewId', NEW.id::text)
    ) THEN
      RAISE EXCEPTION 'formal_qa_review_authority_mismatch';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.project_workspace_id IS DISTINCT FROM OLD.project_workspace_id
    OR NEW.preparation_id IS DISTINCT FROM OLD.preparation_id OR NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
    OR NEW.checkout_id IS DISTINCT FROM OLD.checkout_id OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.reviewer_agent_id IS DISTINCT FROM OLD.reviewer_agent_id
    OR NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id
    OR NEW.wakeup_request_id IS DISTINCT FROM OLD.wakeup_request_id OR NEW.heartbeat_run_id IS DISTINCT FROM OLD.heartbeat_run_id
    OR NEW.repository IS DISTINCT FROM OLD.repository OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
    OR NEW.head_sha IS DISTINCT FROM OLD.head_sha OR NEW.tree_sha IS DISTINCT FROM OLD.tree_sha
    OR NEW.issuance_sha256 IS DISTINCT FROM OLD.issuance_sha256 OR NEW.checkout_sha256 IS DISTINCT FROM OLD.checkout_sha256
    OR NEW.contract_sha256 IS DISTINCT FROM OLD.contract_sha256
    OR NEW.reviewer_config_sha256 IS DISTINCT FROM OLD.reviewer_config_sha256
    OR NEW.prompt_sha256 IS DISTINCT FROM OLD.prompt_sha256
    OR NEW.source_snapshot_json IS DISTINCT FROM OLD.source_snapshot_json
    OR NEW.source_snapshot_sha256 IS DISTINCT FROM OLD.source_snapshot_sha256
    OR NEW.source_manifest_json IS DISTINCT FROM OLD.source_manifest_json
    OR NEW.source_manifest_sha256 IS DISTINCT FROM OLD.source_manifest_sha256
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'formal_qa_review_authority_immutable';
  END IF;

  IF OLD.status = 'queued' AND NEW.status = 'running' THEN
    IF NOT formal_qa_review_has_live_authority(NEW)
      OR NEW.started_at IS NULL OR NEW.finished_at IS NOT NULL OR NEW.decision IS NOT NULL
      OR NEW.decision_artifact IS NOT NULL OR NEW.decision_sha256 IS NOT NULL OR NEW.terminal_reason IS NOT NULL THEN
      RAISE EXCEPTION 'formal_qa_review_claim_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'queued' AND NEW.status IN ('failed', 'cancelled', 'expired') THEN
    IF NEW.started_at IS NOT NULL OR NEW.finished_at IS NULL OR NEW.decision IS NOT NULL
      OR NEW.decision_artifact IS NOT NULL OR NEW.decision_sha256 IS NOT NULL OR NEW.terminal_reason IS NULL THEN
      RAISE EXCEPTION 'formal_qa_review_preclaim_terminal_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status IN ('approved', 'rejected', 'failed', 'cancelled', 'expired', 'tainted') THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS NULL THEN
      RAISE EXCEPTION 'formal_qa_review_terminal_state_invalid';
    END IF;
    IF NEW.status IN ('approved', 'rejected') THEN
      IF NOT formal_qa_review_has_live_authority(NEW)
        OR NEW.decision IS DISTINCT FROM NEW.status OR NEW.decision_artifact IS NULL
        OR NEW.decision_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.decision_artifact::text, 'UTF8')), 'hex')
        OR NEW.terminal_reason IS NOT NULL
        OR NEW.decision_artifact->>'schema' IS DISTINCT FROM 'paperclip.formal-qa-review-decision/v1'
        OR NEW.decision_artifact->>'reviewId' IS DISTINCT FROM NEW.id::text
        OR NEW.decision_artifact->>'runId' IS DISTINCT FROM NEW.heartbeat_run_id::text
        OR NEW.decision_artifact->>'headSha' IS DISTINCT FROM NEW.head_sha
        OR NEW.decision_artifact->>'treeSha' IS DISTINCT FROM NEW.tree_sha
        OR NEW.decision_artifact->>'contractSha256' IS DISTINCT FROM NEW.contract_sha256
        OR NEW.decision_artifact->>'decision' IS DISTINCT FROM NEW.status THEN
        RAISE EXCEPTION 'formal_qa_review_decision_invalid';
      END IF;
    ELSIF NEW.decision IS NOT NULL OR NEW.decision_artifact IS NOT NULL OR NEW.decision_sha256 IS NOT NULL
      OR NEW.terminal_reason IS NULL THEN
      RAISE EXCEPTION 'formal_qa_review_failure_invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'formal_qa_review_transition_invalid';
END;
$$;--> statement-breakpoint
CREATE TRIGGER formal_qa_review_guard_trigger
BEFORE INSERT OR UPDATE ON formal_qa_reviews
FOR EACH ROW EXECUTE FUNCTION formal_qa_review_guard();
