-- Down: add_decisions

DROP INDEX IF EXISTS "decisions_status_idx";
DROP INDEX IF EXISTS "decisions_source_project_slug_idx";
DROP INDEX IF EXISTS "decisions_company_source_key_uq";
DROP TABLE IF EXISTS "decisions";
