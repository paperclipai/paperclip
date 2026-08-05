ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "redirect_uri" text;
