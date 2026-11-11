DROP INDEX "account_issuer_account_id_uq";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_id_uq" ON "account" USING btree ("provider_id","account_id");