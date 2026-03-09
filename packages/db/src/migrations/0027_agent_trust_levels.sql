ALTER TABLE "agents" ADD COLUMN "trust_level" text DEFAULT 'supervised' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "trust_promotion_threshold" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "trust_manually_set_at" timestamp with time zone;