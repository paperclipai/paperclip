ALTER TABLE "provider_credentials" ADD COLUMN "cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "cooldown_reason" text;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_events_company_credential_occurred_idx" ON "cost_events" USING btree ("company_id","credential_id","occurred_at");
