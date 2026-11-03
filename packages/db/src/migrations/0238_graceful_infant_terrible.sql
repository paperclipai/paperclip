ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_boot_id" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_pid" integer;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_process_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "controller_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "recovery_state" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "recovery_request_id" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN IF NOT EXISTS "recovery_history" jsonb DEFAULT '[]'::jsonb NOT NULL;
