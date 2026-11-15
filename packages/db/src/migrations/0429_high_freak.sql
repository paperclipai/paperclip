CREATE TABLE IF NOT EXISTS "native_harness_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"scope_digest" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reference" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "native_harness_backups_current_idx" ON "native_harness_backups" USING btree ("company_id","scope_digest") WHERE "native_harness_backups"."status" = 'current';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "native_harness_backups_scope_idx" ON "native_harness_backups" USING btree ("company_id","scope_digest","manifest_sha256");
