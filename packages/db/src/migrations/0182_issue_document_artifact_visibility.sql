ALTER TABLE "issue_documents"
  ADD COLUMN IF NOT EXISTS "artifact_visible" boolean DEFAULT true NOT NULL;
