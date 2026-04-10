DROP INDEX "agent_api_keys_key_hash_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_api_keys_key_hash_idx" ON "agent_api_keys" USING btree ("key_hash");