DROP INDEX "account_pool_state_company_uq";--> statement-breakpoint
ALTER TABLE "account_pool_state" ADD COLUMN "provider" text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_pool_state_company_provider_uq" ON "account_pool_state" USING btree ("company_id","provider");