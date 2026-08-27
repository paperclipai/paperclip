CREATE TABLE "native_semantic_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"scope_digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_semantic_receipts" ADD CONSTRAINT "native_semantic_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_semantic_receipts" ADD CONSTRAINT "native_semantic_receipts_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_semantic_receipts" ADD CONSTRAINT "native_semantic_receipts_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_semantic_receipts_run_scope_uq" ON "native_semantic_receipts" USING btree ("run_id","scope_digest");