ALTER TABLE "native_run_finalizations" ADD COLUMN "controller_boot_id" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "controller_pid" integer;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "controller_process_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "controller_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "recovery_state" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "recovery_request_id" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "recovery_history" jsonb DEFAULT '[]'::jsonb NOT NULL;