-- Backfill documents.document_type from their issue-document key so the
-- Documents library "Type" filter matches the key chip rendered in each row.
-- Auto-generated issue docs were created with document_type = 'other'
-- regardless of key (plan/spec/brief/report), so Type=Plan never matched.
-- Idempotent: only rows still at the default 'other' are touched, preserving
-- any document_type a user set manually. Locked-document fallback keys carry a
-- numeric suffix (e.g. plan-2), which is stripped before matching.
UPDATE "documents" AS d
SET "document_type" = CASE regexp_replace(lower(btrim(id."key")), '-[0-9]+$', '')
    WHEN 'plan' THEN 'plan'
    WHEN 'spec' THEN 'spec'
    WHEN 'brief' THEN 'brief'
    WHEN 'report' THEN 'report'
    ELSE d."document_type"
  END
FROM "issue_documents" AS id
WHERE id."document_id" = d."id"
  AND d."document_type" = 'other'
  AND regexp_replace(lower(btrim(id."key")), '-[0-9]+$', '') IN ('plan', 'spec', 'brief', 'report');
