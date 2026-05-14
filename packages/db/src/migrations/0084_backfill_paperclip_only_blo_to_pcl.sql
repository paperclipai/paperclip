-- Phase 3 of the Linear ↔ Paperclip ID Unification plan.
-- See onprem-k8s commit 9979d0d / .planning/linear-id-unification.md.
--
-- For paperclip-only "BLO-N" issues (no linear_issue_links row pointing at
-- them), re-prefix to "PCL-N". The pre-rename identifier is stashed in
-- legacy_identifier so the rename can be reverted with a single UPDATE if
-- the cutover misfires:
--
--   UPDATE issues SET identifier = legacy_identifier, legacy_identifier = NULL
--    WHERE legacy_identifier ~ '^BLO-[0-9]+$' AND identifier ~ '^PCL-[0-9]+$';
--
-- Scope: every company whose pre-existing paperclip BLO-N issues have no
-- Linear counterpart yet. Today (2026-05-03 audit) this is the BLO company
-- alone — 2377 paperclip-only issues, zero linked. The query is written
-- generically so it's safe to re-run when other companies pick up the
-- linear_issue_links workflow later.
--
-- The matching paperclip-side counter (companies.issue_counter) is
-- intentionally NOT reset. The counter only mints new identifiers, and
-- new identifiers will continue to use whatever issue_prefix the company
-- has set (BLO companies that flip to identifier_provider='linear' stop
-- using issue_counter for new issues entirely; BLO companies that don't
-- flip continue from the current value). Resetting it would risk
-- duplicate identifiers if any callers race against the rename.
WITH targets AS (
  SELECT i.id, i.identifier
    FROM issues i
    LEFT JOIN linear_issue_links lil ON lil.paperclip_issue_id = i.id
   WHERE i.identifier ~ '^BLO-[0-9]+$'
     AND lil.id IS NULL
     AND i.legacy_identifier IS NULL  -- skip already-renamed rows (idempotent)
)
UPDATE issues i
   SET legacy_identifier = t.identifier,
       identifier = REGEXP_REPLACE(t.identifier, '^BLO-', 'PCL-'),
       updated_at = now()
  FROM targets t
 WHERE i.id = t.id;
