CREATE TABLE "native_tool_receipt_references" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"key_sha256" text NOT NULL,
	CONSTRAINT "native_tool_receipt_references_pk" PRIMARY KEY("company_id","run_id","kind","target","key_sha256")
);
--> statement-breakpoint
CREATE TABLE "native_tool_receipts" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_tool_receipts_pk" PRIMARY KEY("company_id","run_id","key_sha256")
);
--> statement-breakpoint
ALTER TABLE "native_tool_receipt_references" ADD CONSTRAINT "native_tool_receipt_references_receipt_fk" FOREIGN KEY ("company_id","run_id","key_sha256") REFERENCES "public"."native_tool_receipts"("company_id","run_id","key_sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_tool_receipts" ADD CONSTRAINT "native_tool_receipts_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Migrate exact business receipts once; foreground writes never rebuild a map.
-- Preserve every value, including malformed legacy values, so corruption cannot
-- become an absent receipt that authorizes repeating an effect.
INSERT INTO native_tool_receipts(company_id, issue_id, run_id, key_sha256, idempotency_key, receipt)
SELECT r.company_id, r.native_issue_id, r.id,
       encode(sha256(convert_to(entry.key, 'UTF8')), 'hex'), entry.key, entry.value
FROM heartbeat_runs r
CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.result_json->'semanticToolReceipts') = 'object'
  THEN r.result_json->'semanticToolReceipts' ELSE '{}'::jsonb END) entry
WHERE r.runtime_mode = 'native' AND r.native_issue_id IS NOT NULL;
--> statement-breakpoint
INSERT INTO native_tool_receipt_references(company_id, run_id, kind, target, key_sha256)
SELECT r.company_id, r.run_id, 'generated-comment', r.receipt->'result'->>'commentId', r.key_sha256
FROM native_tool_receipts r
WHERE r.receipt->>'operationId' = 'report_progress'
  AND r.receipt->'result'->>'commentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO native_tool_receipt_references(company_id, run_id, kind, target, key_sha256)
SELECT r.company_id, r.run_id, 'publication', r.receipt->'result'->'entityRefs'->>0, r.key_sha256
FROM native_tool_receipts r
WHERE r.receipt->>'operationId' IN ('register_deliverable', 'reuse_chat_attachment')
  AND r.receipt->'result'->>'disposition' IN ('applied', 'duplicate')
  AND r.receipt->'result'->'entityRefs'->>0 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (
    (r.receipt->>'operationId' = 'register_deliverable'
      AND r.receipt->'result'->>'attachmentId' = r.receipt->'result'->'entityRefs'->>0
      AND r.receipt->'result'->>'commandId' = 'deliverable-prepared:' || (r.receipt->'result'->>'attachmentId'))
    OR
    (r.receipt->>'operationId' = 'reuse_chat_attachment'
      AND r.receipt->'result'->'prepared'->>'attachmentId' = r.receipt->'result'->'entityRefs'->>0
      AND r.receipt->'result'->>'commandId' = 'chat-attachment-reused:' || (r.receipt->'result'->'prepared'->>'attachmentId'))
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO native_tool_receipt_references(company_id, run_id, kind, target, key_sha256)
SELECT r.company_id, r.run_id, 'generated-comment', ref.value, r.key_sha256
FROM native_tool_receipts r
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.receipt->'result'->'entityRefs') = 'array'
  THEN r.receipt->'result'->'entityRefs' ELSE '[]'::jsonb END) ref
WHERE r.receipt->>'operationId' IN ('register_deliverable', 'reuse_chat_attachment')
  AND r.receipt->'result'->>'disposition' IN ('applied', 'duplicate')
  AND ref.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (
    (r.receipt->>'operationId' = 'register_deliverable'
      AND r.receipt->'result'->>'attachmentId' = r.receipt->'result'->'entityRefs'->>0
      AND r.receipt->'result'->>'commandId' = 'deliverable-prepared:' || (r.receipt->'result'->>'attachmentId'))
    OR
    (r.receipt->>'operationId' = 'reuse_chat_attachment'
      AND r.receipt->'result'->'prepared'->>'attachmentId' = r.receipt->'result'->'entityRefs'->>0
      AND r.receipt->'result'->>'commandId' = 'chat-attachment-reused:' || (r.receipt->'result'->'prepared'->>'attachmentId')
      AND ref.value = r.receipt->'result'->'prepared'->>'commentId'
      AND r.receipt->'result'->'prepared'->>'commentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO native_tool_receipt_references(company_id, run_id, kind, target, key_sha256)
SELECT r.company_id, r.run_id, 'attachment-reuse',
       (r.receipt->'input'->>'sourceCommentId') || '/' || (r.receipt->'input'->>'attachmentId'), r.key_sha256
FROM native_tool_receipts r
WHERE r.receipt->>'operationId' = 'reuse_chat_attachment'
  -- Keep the duplicate-effect fence even for a damaged legacy result; runtime
  -- lookup fails closed on its result rather than admitting the same reuse.
  AND r.receipt->'input'->>'sourceCommentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND r.receipt->'input'->>'attachmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE heartbeat_runs SET result_json = result_json - 'semanticToolReceipts'
WHERE runtime_mode = 'native' AND native_issue_id IS NOT NULL
  AND jsonb_typeof(result_json->'semanticToolReceipts') = 'object';
