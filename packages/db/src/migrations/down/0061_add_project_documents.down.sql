-- Down: add_project_documents

DROP INDEX IF EXISTS "project_documents_company_project_updated_idx";
DROP INDEX IF EXISTS "project_documents_document_uq";
DROP INDEX IF EXISTS "project_documents_company_project_key_uq";
DROP TABLE IF EXISTS "project_documents";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "tags";
