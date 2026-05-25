-- Migration 0091: change attachment_max_bytes to BIGINT NULL
--
-- NULL now means "use system default (10 MB)". Non-null values are
-- company-specific overrides approved by the board and written by an
-- operator. BIGINT is required for values up to the 2 GB hard limit.

ALTER TABLE "companies"
  ALTER COLUMN "attachment_max_bytes" TYPE bigint USING "attachment_max_bytes"::bigint,
  ALTER COLUMN "attachment_max_bytes" DROP NOT NULL,
  ALTER COLUMN "attachment_max_bytes" DROP DEFAULT;

-- Null out the universal 10 MB default so those companies track the
-- system default going forward (operator-set overrides would differ).
UPDATE "companies"
  SET "attachment_max_bytes" = NULL
  WHERE "attachment_max_bytes" = 10485760;
