ALTER TABLE "muse_agent_bindings" ADD COLUMN IF NOT EXISTS "detector_removal_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD COLUMN IF NOT EXISTS "signal_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD COLUMN IF NOT EXISTS "signal_notified_at" timestamp with time zone;