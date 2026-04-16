ALTER TABLE "routines" ADD COLUMN "execution_mode" text NOT NULL DEFAULT 'agent';
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "script_body" text;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "script_timeout_sec" integer NOT NULL DEFAULT 60;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "script_output" text;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "script_exit_code" integer;
