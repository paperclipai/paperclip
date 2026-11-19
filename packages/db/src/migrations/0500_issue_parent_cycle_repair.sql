-- paperclip:migration-compat online_compatible: this is a bounded data repair that only sets parent_id to NULL on the few rows whose parent chain is cyclic (production audits found zero beyond the row ops already fixed); NULL is a value the previous release already reads and writes for top-level issues, there are no schema object changes, every statement reads or writes only bounded bare-id sets (rows that reach a top-level issue, then the shrinking candidate staging table, then the corrupt edges themselves), and each UPDATE takes short row locks that the corrupt edges never block on.
-- Repair poisoned issue parent edges. A row whose parent_id pointed at its own
-- id (or at one of its own descendants) made every `UNION ALL` subtree walk
-- over `issues` recurse forever, growing giant sorts that spilled to disk
-- (pgsql_tmp) until the host root volume filled. Parent writes now reject such
-- edges (server/src/services/issue-hierarchy.ts); this migration repairs rows
-- that were written before that guard existed.
-- The repair is re-runnable: once no cyclic edge remains it no-ops. It never
-- carries a per-row path array, so its temporary storage stays linear in the
-- number of issues instead of quadratic in a cycle's length, and it uses no
-- depth bound: cycles of any length are repaired, rows merely hanging below a
-- cycle keep their parent edge, and healthy trees are not walked per row.

-- 1) Self-parent edges: parent_id pointing at the row itself.
UPDATE "issues"
SET "parent_id" = NULL
WHERE "parent_id" IS NOT NULL
  AND "parent_id" = "id";
--> statement-breakpoint
-- 2) Longer cycles of any length. Stage the only rows that can sit on a
-- cycle: parented rows whose parent chain never reaches a top-level issue.
-- Reachability flows down from the top-level issues one bare id per row, so
-- the statement's temporary use is linear in the issue count with no path
-- arrays and no dependence on tree depth or cycle length.
CREATE TEMP TABLE "issue_parent_cycle_candidates" ON COMMIT DROP AS
WITH RECURSIVE "rooted" AS (
  SELECT "issues"."id"
  FROM "issues"
  WHERE "issues"."parent_id" IS NULL
  UNION
  SELECT "issues"."id"
  FROM "issues"
  JOIN "rooted" ON "rooted"."id" = "issues"."parent_id"
)
SELECT "issues"."id", "issues"."parent_id"
FROM "issues"
WHERE "issues"."parent_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "rooted" WHERE "rooted"."id" = "issues"."id"
  );
--> statement-breakpoint
-- 3) Peel the staged rows down to the exact cycle members. A candidate that
-- no remaining candidate points at is a row hanging below the cycle: the
-- deepest hanging rows peel first and their parents follow, while every
-- cycle member keeps being pointed at by its cyclic predecessor and never
-- peels. Each round is one small DELETE over the staging table, so
-- per-statement temporary use stays bounded whatever the cycle length.
DO $$
BEGIN
  LOOP
    DELETE FROM "issue_parent_cycle_candidates" AS "candidate"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "issue_parent_cycle_candidates" AS "child"
      WHERE "child"."parent_id" = "candidate"."id"
    );
    EXIT WHEN NOT FOUND;
  END LOOP;
END
$$;
--> statement-breakpoint
-- 4) Break every cycle: each surviving candidate is a cycle member, and its
-- parent edge goes. Rows hanging below a cycle were peeled in step 3, so
-- they keep their parent edge into the (now root-level) repaired member.
UPDATE "issues" AS "victim"
SET "parent_id" = NULL
FROM "issue_parent_cycle_candidates"
WHERE "victim"."id" = "issue_parent_cycle_candidates"."id";
