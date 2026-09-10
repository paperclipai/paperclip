ALTER TABLE "delivery_findings" ADD COLUMN "candidate_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD COLUMN "authorization_invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD COLUMN "authorization_invalidated_scope" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_repair_attempts" ADD COLUMN "signal" text;--> statement-breakpoint
ALTER TABLE "delivery_repair_attempts" ADD COLUMN "candidate_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_units" ADD COLUMN "candidate_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "delivery_repair_attempts_signal_idx" ON "delivery_repair_attempts" USING btree ("unit_id","reason_code","signal");