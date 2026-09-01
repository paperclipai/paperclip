ALTER TABLE "formal_qa_preparations" ADD COLUMN "canonical_preparation_id" uuid;--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD CONSTRAINT "formal_qa_preparations_canonical_preparation_id_formal_qa_preparations_id_fk" FOREIGN KEY ("canonical_preparation_id") REFERENCES "public"."formal_qa_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_preparation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Preserve the receipt against direct deletion and project/workspace
    -- cleanup, while allowing the existing company-level ON DELETE CASCADE
    -- contract to erase the entire tenant after its parent row is gone.
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'formal_qa_preparation_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'prepared' OR NEW.canonical_preparation_id IS NOT NULL
      OR NEW.pr_number < 1 OR NEW.repository !~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$'
      OR NEW.head_sha <> repeat('0', 40) OR NEW.base_ref <> 'pending'
      OR NEW.base_sha <> repeat('0', 40) OR NEW.tree_sha <> repeat('0', 40)
      OR NEW.evidence_sha256 <> repeat('0', 64) OR NEW.issuer_receipt_sha256 <> repeat('0', 64)
      OR NEW.issuer_operation_id !~ '^request:[0-9a-f-]+:v[1-9][0-9]*$'
      OR NEW.issued_by_user_id = '' OR NEW.idempotency_key = ''
      OR NEW.request_sha256 !~ '^[0-9a-f]{64}$'
      OR NOT EXISTS (
        SELECT 1 FROM projects p
        JOIN project_workspaces w ON w.id = NEW.project_workspace_id
        WHERE p.id = NEW.project_id AND p.company_id = NEW.company_id
          AND w.company_id = NEW.company_id AND w.project_id = NEW.project_id
      ) THEN
      RAISE EXCEPTION 'formal_qa_preparation_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.project_workspace_id IS DISTINCT FROM OLD.project_workspace_id
    OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
    OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'formal_qa_preparation_authority_immutable';
  END IF;

  IF OLD.status IN ('prepared', 'issuing') AND NEW.status = 'issuing' THEN
    IF NEW.repository IS DISTINCT FROM OLD.repository
      OR NEW.head_sha IS DISTINCT FROM OLD.head_sha OR NEW.base_ref IS DISTINCT FROM OLD.base_ref
      OR NEW.base_sha IS DISTINCT FROM OLD.base_sha OR NEW.tree_sha IS DISTINCT FROM OLD.tree_sha
      OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
      OR NEW.issuer_receipt_sha256 IS DISTINCT FROM OLD.issuer_receipt_sha256
      OR NEW.issuer_operation_id IS DISTINCT FROM OLD.issuer_operation_id
      OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.canonical_preparation_id IS NOT NULL THEN
      RAISE EXCEPTION 'formal_qa_preparation_transition_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('prepared', 'issuing') AND NEW.status = 'issued' THEN
    IF NEW.canonical_preparation_id IS NOT NULL
      OR NEW.repository !~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$'
      OR NEW.head_sha !~ '^[0-9a-f]{40}$' OR NEW.head_sha = repeat('0', 40)
      OR NEW.base_ref = '' OR NEW.base_ref = 'pending'
      OR NEW.base_sha !~ '^[0-9a-f]{40}$' OR NEW.base_sha = repeat('0', 40)
      OR NEW.tree_sha !~ '^[0-9a-f]{40}$' OR NEW.tree_sha = repeat('0', 40)
      OR NEW.evidence_sha256 !~ '^[0-9a-f]{64}$' OR NEW.evidence_sha256 = repeat('0', 64)
      OR NEW.issuer_receipt_sha256 IS DISTINCT FROM NEW.evidence_sha256
      OR NEW.issuer_operation_id !~ '^github-pr:[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*#[1-9][0-9]*@[0-9a-f]{40}:policy:[0-9a-f-]+:v[1-9][0-9]*$'
      OR NEW.request_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'formal_qa_preparation_issue_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('prepared', 'issuing', 'issued') AND NEW.status = 'expired' THEN
    IF OLD.expires_at > clock_timestamp() OR NEW.canonical_preparation_id IS NOT NULL
      OR NEW.repository IS DISTINCT FROM OLD.repository
      OR NEW.head_sha IS DISTINCT FROM OLD.head_sha OR NEW.base_ref IS DISTINCT FROM OLD.base_ref
      OR NEW.base_sha IS DISTINCT FROM OLD.base_sha OR NEW.tree_sha IS DISTINCT FROM OLD.tree_sha
      OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
      OR NEW.issuer_receipt_sha256 IS DISTINCT FROM OLD.issuer_receipt_sha256
      OR NEW.issuer_operation_id IS DISTINCT FROM OLD.issuer_operation_id
      OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'formal_qa_preparation_expiry_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('prepared', 'issuing') AND NEW.status = 'superseded' THEN
    IF NEW.repository IS DISTINCT FROM OLD.repository
      OR NEW.head_sha IS DISTINCT FROM OLD.head_sha OR NEW.base_ref IS DISTINCT FROM OLD.base_ref
      OR NEW.base_sha IS DISTINCT FROM OLD.base_sha OR NEW.tree_sha IS DISTINCT FROM OLD.tree_sha
      OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
      OR NEW.issuer_receipt_sha256 IS DISTINCT FROM OLD.issuer_receipt_sha256
      OR NEW.issuer_operation_id IS DISTINCT FROM OLD.issuer_operation_id
      OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.canonical_preparation_id IS NULL OR NEW.canonical_preparation_id = NEW.id
      OR NOT EXISTS (
        SELECT 1 FROM formal_qa_preparations canonical
        WHERE canonical.id = NEW.canonical_preparation_id AND canonical.status = 'issued'
          AND canonical.company_id = NEW.company_id AND canonical.project_id = NEW.project_id
          AND canonical.project_workspace_id = NEW.project_workspace_id
          AND canonical.repository = NEW.repository AND canonical.pr_number = NEW.pr_number
      ) THEN
      RAISE EXCEPTION 'formal_qa_preparation_supersession_invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'formal_qa_preparation_transition_invalid';
END;
$$;--> statement-breakpoint
CREATE TRIGGER formal_qa_preparation_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON formal_qa_preparations
FOR EACH ROW EXECUTE FUNCTION formal_qa_preparation_guard();--> statement-breakpoint
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
  IF OLD.status <> 'creating'
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.preparation_id IS DISTINCT FROM OLD.preparation_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.project_workspace_id IS DISTINCT FROM OLD.project_workspace_id
    OR NEW.repository IS DISTINCT FROM OLD.repository OR NEW.repo_root IS DISTINCT FROM OLD.repo_root
    OR NEW.checkout_path IS DISTINCT FROM OLD.checkout_path OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
    OR NEW.tree_sha IS DISTINCT FROM OLD.tree_sha OR NEW.checkout_sha256 IS DISTINCT FROM OLD.checkout_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'formal_qa_checkout_immutable';
  END IF;
  IF NEW.status = 'verified' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'expired' AND EXISTS (
    SELECT 1 FROM formal_qa_preparations p
    WHERE p.id = NEW.preparation_id AND p.status = 'expired'
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'formal_qa_checkout_transition_invalid';
END;
$$;--> statement-breakpoint
