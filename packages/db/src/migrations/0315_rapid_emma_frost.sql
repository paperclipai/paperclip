CREATE TABLE IF NOT EXISTS "user_company_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"primary_agent_id" uuid,
	"primary_agent_initialized" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_company_preferences" ADD CONSTRAINT "user_company_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_company_preferences" ADD CONSTRAINT "user_company_preferences_primary_agent_id_agents_id_fk" FOREIGN KEY ("primary_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_company_preferences_company_user_uq" ON "user_company_preferences" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_company_preferences_primary_agent_idx" ON "user_company_preferences" USING btree ("primary_agent_id");--> statement-breakpoint
-- Attribute only explicit human creation events. Select the original event
-- before joining the agent: deletion/termination must not promote a later hire.
WITH first_creations AS (
  SELECT DISTINCT ON (company_id, actor_id)
    company_id, actor_id AS user_id, entity_id AS agent_id
  FROM activity_log
  WHERE actor_type = 'user'
    AND actor_id NOT IN ('', 'board', 'system', 'unknown', 'unknown-user')
    AND entity_type = 'agent'
    AND action IN ('agent.created', 'agent.hire_created')
  ORDER BY company_id, actor_id, created_at, id
)
INSERT INTO user_company_preferences (company_id, user_id, primary_agent_id, primary_agent_initialized)
SELECT c.company_id, c.user_id,
  CASE WHEN a.status != 'terminated' AND m.state IS DISTINCT FROM 'left'
    THEN a.id ELSE NULL END,
  true
FROM first_creations c
LEFT JOIN agents a ON a.id::text = c.agent_id AND a.company_id = c.company_id
LEFT JOIN agent_memberships m ON m.company_id = c.company_id AND m.user_id = c.user_id AND m.agent_id = a.id
WHERE a.metadata->'paperclipBuiltInAgent' IS NULL
ON CONFLICT (company_id, user_id) DO NOTHING;
