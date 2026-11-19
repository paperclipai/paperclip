-- paperclip:migration-compat online_compatible: this is a bounded data repair that only sets parent_id to NULL on the few rows whose parent chain is cyclic (production audits found zero beyond the row ops already fixed); NULL is a value the previous release already reads and writes for top-level issues, no schema object changes, and each UPDATE takes short row locks that the corrupt edges never block on.
-- Repair poisoned issue parent edges. A row whose parent_id pointed at its own
-- id (or at one of its own descendants) made every `UNION ALL` subtree walk
-- over `issues` recurse forever, growing giant sorts that spilled to disk
-- (pgsql_tmp) until the host root volume filled. Parent writes now reject such
-- edges (server/src/services/issue-hierarchy.ts); this migration repairs rows
-- that were written before that guard existed.
-- Both statements are re-runnable: once no cyclic edge remains they no-op.
-- The upward walk carries a path guard that stops it on a repeated issue, so
-- it always terminates; the single allowed repeat is the closure step onto the
-- starting row, which is how the cycle is detected.

-- 1) Self-parent edges: parent_id pointing at the row itself.
UPDATE "issues"
SET "parent_id" = NULL
WHERE "parent_id" IS NOT NULL
  AND "parent_id" = "id";
--> statement-breakpoint
-- 2) Longer cycles of any length: walk up from every row while remembering
-- every issue already visited. The walk may step onto a node it has already
-- seen exactly once — that repeat is the closure proving the chain loops back
-- through the starting row — and stops there, so no depth bound is needed and
-- cycles of any length are repaired. Rows that merely hang below a cycle keep
-- their parent edge: their own walk stops at the cycle's first repeated
-- member and never returns to the hanging row.
WITH RECURSIVE walk AS (
  SELECT
    "issues"."id" AS "member_id",
    "issues"."parent_id" AS "node_id",
    ARRAY["issues"."id"] AS "path"
  FROM "issues"
  WHERE "issues"."parent_id" IS NOT NULL
  UNION ALL
  SELECT
    walk."member_id",
    nxt."parent_id",
    walk."path" || nxt."parent_id"
  FROM walk
  JOIN "issues" nxt ON nxt."id" = walk."node_id"
  WHERE nxt."parent_id" IS NOT NULL
    AND (
      nxt."parent_id" = walk."member_id"
      OR nxt."parent_id" <> ALL (walk."path")
    )
)
UPDATE "issues" AS victim
SET "parent_id" = NULL
FROM (
  SELECT DISTINCT "member_id"
  FROM walk
  WHERE "node_id" = "member_id"
) AS cyclic
WHERE victim."id" = cyclic."member_id";
