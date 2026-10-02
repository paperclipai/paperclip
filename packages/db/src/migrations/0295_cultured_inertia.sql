-- Replay-cache rows from 0290 cannot be attributed to a company (the nonce was
-- keyed by sender only), so the pre-merge cache is dropped; replay protection
-- resumes fresh and the message stable-id/content hash still guards storage.
DELETE FROM "pubsub_nonces";
--> statement-breakpoint
ALTER TABLE "pubsub_nonces" DROP CONSTRAINT "pubsub_nonces_peer_instance_id_nonce_pk";
--> statement-breakpoint
ALTER TABLE "pubsub_nonces" ADD COLUMN "company_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "pubsub_nonces" ADD CONSTRAINT "pubsub_nonces_company_id_peer_instance_id_nonce_pk" PRIMARY KEY("company_id","peer_instance_id","nonce");
--> statement-breakpoint
ALTER TABLE "pubsub_nonces" ADD CONSTRAINT "pubsub_nonces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pubsub_messages_prune_idx" ON "pubsub_messages" USING btree ("acked_at");
--> statement-breakpoint
CREATE INDEX "pubsub_nonces_retention_idx" ON "pubsub_nonces" USING btree ("company_id","received_at");
