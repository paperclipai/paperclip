-- Change the DB-level default for issues.status from 'backlog' to 'todo'.
-- The Zod validator already provides this value for all API-created issues,
-- but aligning the column default prevents 'backlog' from leaking into any
-- direct SQL inserts or seed scripts that omit the status field.
ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'todo';
