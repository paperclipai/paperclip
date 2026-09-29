ALTER TABLE "issue_comments" ADD COLUMN "native_tool_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Materialize the exclusion once so finding a final response does not scan
-- every earlier progress/file-preparation comment in a long active run.
UPDATE issue_comments c SET native_tool_generated = true
FROM native_tool_receipt_references ref
JOIN native_tool_receipts receipt ON receipt.company_id = ref.company_id
  AND receipt.run_id = ref.run_id AND receipt.key_sha256 = ref.key_sha256
WHERE ref.kind = 'generated-comment' AND ref.target = c.id::text
  AND c.company_id = ref.company_id AND c.created_by_run_id = ref.run_id
  AND c.issue_id = receipt.issue_id;
--> statement-breakpoint

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The generated-comment backfill and response index must publish together under the transactional migrator; CONCURRENTLY cannot run inside it. Schedule a maintenance window for this one-time history-sized backfill/index build before admitting normalized receipt writers.
CREATE INDEX "issue_comments_native_run_response_idx" ON "issue_comments" USING btree ("company_id","created_by_run_id","issue_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE NOT "issue_comments"."native_tool_generated";
