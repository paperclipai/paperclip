ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "agent_skill_profile_defaults" jsonb DEFAULT '{"executive":["paperclipai/paperclip/paperclip"],"ic":["paperclipai/paperclip/paperclip-ic"],"merge-bot":["paperclipai/paperclip/paperclip-ic"],"custom":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "agent_skill_profile" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
UPDATE "agents"
SET "agent_skill_profile" = CASE
  WHEN lower(regexp_replace("name", '[^a-zA-Z0-9]+', '', 'g')) IN ('mergebot', 'mergebotagent') THEN 'merge-bot'
  WHEN "role" IN ('ceo', 'cto', 'cfo', 'cmo') THEN 'executive'
  ELSE 'ic'
END
WHERE "agent_skill_profile" = 'custom';
