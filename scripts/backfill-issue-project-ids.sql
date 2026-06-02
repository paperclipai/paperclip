-- Backfill: set projectId on open issues that have null projectId but an ancestor with one.
-- Walks up to 8 levels of parent-child nesting.
-- Safe to run multiple times (WHERE projectId IS NULL guard).
--
-- Run: psql "$DATABASE_URL" -f scripts/backfill-issue-project-ids.sql

WITH RECURSIVE ancestor_projects AS (
  -- Anchor: start from open issues with null projectId and a parentId
  SELECT
    i.id         AS issue_id,
    i.company_id AS company_id,
    i.parent_id  AS current_id,
    1            AS depth
  FROM issues i
  WHERE i.project_id IS NULL
    AND i.parent_id IS NOT NULL
    AND i.status IN ('todo', 'in_progress', 'in_review', 'blocked')

  UNION ALL

  -- Recurse: walk up the parent chain
  SELECT
    ap.issue_id,
    ap.company_id,
    p.parent_id  AS current_id,
    ap.depth + 1 AS depth
  FROM ancestor_projects ap
  JOIN issues p ON p.id = ap.current_id AND p.company_id = ap.company_id
  WHERE p.project_id IS NULL
    AND p.parent_id IS NOT NULL
    AND ap.depth < 8
),

-- Find the first ancestor with a projectId for each issue
resolved AS (
  SELECT DISTINCT ON (ap.issue_id)
    ap.issue_id,
    p.project_id
  FROM ancestor_projects ap
  JOIN issues p ON p.id = ap.current_id AND p.company_id = ap.company_id
  WHERE p.project_id IS NOT NULL
  ORDER BY ap.issue_id, ap.depth
)

UPDATE issues
SET project_id = resolved.project_id
FROM resolved
WHERE issues.id = resolved.issue_id
  AND issues.project_id IS NULL;
