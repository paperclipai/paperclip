ALTER TABLE "heartbeat_runs" ADD COLUMN "transient_retry_count" integer DEFAULT 0 NOT NULL;
