ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "run_io_mode" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "journal_stdout_offset" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "journal_stderr_offset" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_preservable" boolean DEFAULT false NOT NULL;
