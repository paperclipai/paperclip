CREATE TABLE IF NOT EXISTS "sandbox_creation_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid,
	"original_environment_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"request_key" text DEFAULT 'run' NOT NULL,
	"issue_id" uuid,
	"execution_workspace_id" uuid,
	"provider" text NOT NULL,
	"plugin_id" uuid,
	"driver_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"config" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"lease_id" uuid,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sandbox_creation_operations_environment_id_environments_id_fk'
      AND conrelid = 'sandbox_creation_operations'::regclass
  ) THEN
    ALTER TABLE "sandbox_creation_operations" ADD CONSTRAINT "sandbox_creation_operations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_creation_operations_pending_deadline_idx" ON "sandbox_creation_operations" USING btree ("next_attempt_at") WHERE "sandbox_creation_operations"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_creation_operations_owner_idx" ON "sandbox_creation_operations" USING btree ("company_id","original_environment_id","run_id","request_key");