ALTER TABLE "muse_agent_bindings" ADD COLUMN "detector_removal_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD COLUMN "signal_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ADD COLUMN "signal_notified_at" timestamp with time zone;