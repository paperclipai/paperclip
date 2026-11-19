-- paperclip:migration-compat online_compatible: this is a bounded data repair that only sets parent_id to NULL on the few rows whose parent chain is cyclic (production audits found zero beyond the row ops already fixed); NULL is a value the previous release already reads and writes for top-level issues, no schema object changes, and each UPDATE takes short row locks that the corrupt edges never block on.
-- Repair poisoned issue parent edges. A row whose parent_id pointed at its own
-- id (or at one of its own descendants) made every `UNION ALL` subtree walk
-- over `issues` recurse forever, growing giant sorts that spilled to disk
-- (pgsql_tmp) until the host root volume filled. Parent writes now reject such
-- edges (server/src/services/issue-hierarchy.ts); this migration repairs rows
-- that were written before that guard existed.
-- Both statements are re-runnable: once no cyclic edge remains they no-op.
-- The walk intentionally does not carry a path guard: it must be able to step
-- onto a node it has already seen to detect that the chain closed a cycle.

-- 1) Self-parent edges: parent_id pointing at the row itself.
UPDATE "issues"
SET "parent_id" = NULL
WHERE "parent_id" IS NOT NULL
  AND "parent_id" = "id";
--> statement-breakpoint
-- 2) Longer cycles: flag every row whose bounded upward walk returns to the
-- row itself (its parent chain loops back through it), then NULL that row's
-- parent edge to break the cycle. The walk is depth-capped at 200 so it
-- terminates even if the data holds a longer or malformed chain. Rows that
-- merely hang below a cycle keep their parent edge: their own walk loops among
-- the cycle members but never returns to the hanging row.
WITH RECURSIVE walk AS (
  SELECT
    "issues"."id" AS "member_id",
    "issues"."parent_id" AS "parent_id",
    0 AS "depth"
  FROM "issues"
  WHERE "issues"."parent_id" IS NOT NULL
  UNION ALL
  SELECT
    walk."member_id",
    parent."parent_id",
    walk."depth" + 1
  FROM walk
  JOIN "issues" parent ON parent."id" = walk."parent_id"
  WHERE walk."depth" < 200
)
UPDATE "issues" AS victim
SET "parent_id" = NULL
FROM (
  SELECT DISTINCT "member_id"
  FROM walk
  WHERE "parent_id" = "member_id"
    AND "depth" > 0
) AS cyclic
WHERE victim."id" = cyclic."member_id";
