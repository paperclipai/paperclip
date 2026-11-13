ALTER TABLE "muse_agent_bindings" ADD COLUMN IF NOT EXISTS "qualification_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ADD COLUMN IF NOT EXISTS "deadline_enforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ADD COLUMN IF NOT EXISTS "cadence_evidence_incomplete_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ADD COLUMN IF NOT EXISTS "timestamps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ADD COLUMN IF NOT EXISTS "incomplete" boolean DEFAULT false NOT NULL;