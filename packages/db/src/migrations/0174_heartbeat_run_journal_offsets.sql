ALTER TABLE "heartbeat_runs" ADD COLUMN "run_io_mode" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "journal_stdout_offset" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "journal_stderr_offset" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_preservable" boolean DEFAULT false NOT NULL;
