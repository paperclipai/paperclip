CREATE TABLE IF NOT EXISTS "execution_workspace_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"source_operation_id" uuid NOT NULL,
	"source_run_id" uuid,
	"parent_snapshot_id" uuid,
	"generation" integer NOT NULL,
	"epoch" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"format" text DEFAULT 'paperclip.remote-workspace-archive.v1' NOT NULL,
	"object_key" text,
	"sha256" text,
	"byte_size" bigint,
	"key" jsonb,
	"manifest_digest" text,
	"metadata" jsonb,
	"delete_after" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspace_snapshots_operation_uniq" ON "execution_workspace_snapshots" USING btree ("company_id","execution_workspace_id","source_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspace_snapshots_generation_uniq" ON "execution_workspace_snapshots" USING btree ("company_id","execution_workspace_id","generation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_workspace_snapshots_workspace_idx" ON "execution_workspace_snapshots" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_workspace_snapshots_cleanup_idx" ON "execution_workspace_snapshots" USING btree ("status","delete_after");