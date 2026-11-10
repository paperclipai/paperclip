CREATE TABLE IF NOT EXISTS "issue_thread_interaction_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "issue_thread_interaction_idempotency_keys" ADD CONSTRAINT "issue_thread_interaction_idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "issue_thread_interaction_idempotency_keys" ADD CONSTRAINT "issue_thread_interaction_idempotency_keys_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "issue_thread_interaction_idempotency_keys" ADD CONSTRAINT "issue_thread_interaction_idempotency_keys_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_thread_interaction_idempotency_keys_scope_key_uq" ON "issue_thread_interaction_idempotency_keys" USING btree ("company_id","issue_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interaction_idempotency_keys_interaction_idx" ON "issue_thread_interaction_idempotency_keys" USING btree ("interaction_id");
