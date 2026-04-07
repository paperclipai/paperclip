DO $$ BEGIN
  IF EXISTS (
    SELECT key_hash FROM agent_api_keys GROUP BY key_hash HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate key_hash values found in agent_api_keys. Resolve duplicates before applying this migration.';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "agent_api_keys_key_hash_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_api_keys_key_hash_idx" ON "agent_api_keys" USING btree ("key_hash");
