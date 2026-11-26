ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "created_by_actor_type" text;
ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "created_by_actor_id" text;

CREATE INDEX IF NOT EXISTS "tool_oauth_states_actor_idx"
  ON "tool_oauth_states" USING btree ("created_by_actor_type", "created_by_actor_id");
