ALTER TABLE "muse_agent_bindings" ADD COLUMN "qualification_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ADD COLUMN "deadline_enforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ADD COLUMN "cadence_evidence_incomplete_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ADD COLUMN "timestamps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ADD COLUMN "incomplete" boolean DEFAULT false NOT NULL;