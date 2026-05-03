-- Migration 0075: enforce unique active routine titles per company
--
-- Breaking-change guard: before creating the unique index, archive all-but-the-newest
-- duplicate active routines so that instances with pre-existing duplicates (e.g. from
-- the routine-proliferation incident) can migrate without error.
--
-- Strategy: within each (company_id, lower(title)) group of non-archived routines,
-- keep the row with the greatest "created_at" (ties broken by id desc) and set
-- status = 'archived' on the rest.  The newest routine is the most likely to be the
-- "intended" one; operators can review and restore specific routines if needed.

UPDATE "routines"
SET    "status" = 'archived'
WHERE  "id" IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY company_id, lower(title)
        ORDER BY created_at DESC, id DESC
      ) AS rn
    FROM "routines"
    WHERE "status" != 'archived'
  ) ranked
  WHERE rn > 1
);

-- Now safe to create the partial unique index.
CREATE UNIQUE INDEX "routines_company_title_active_uq"
  ON "routines" USING btree ("company_id", lower("title"))
  WHERE "status" != 'archived';
