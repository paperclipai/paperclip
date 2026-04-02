-- Add agent_managers join table to support many-to-many manager-agent relationships.
-- Copies existing reports_to data into the new table. The reports_to column is kept
-- for backward compatibility — it will be removed in a follow-up migration once all
-- read/write paths are updated to use agent_managers.

CREATE TABLE IF NOT EXISTS "agent_managers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_managers" ADD CONSTRAINT "agent_managers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_managers" ADD CONSTRAINT "agent_managers_manager_id_agents_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_managers_agent_manager_uniq" ON "agent_managers" USING btree ("agent_id","manager_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_managers_agent_idx" ON "agent_managers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_managers_manager_idx" ON "agent_managers" USING btree ("manager_id");--> statement-breakpoint
INSERT INTO "agent_managers" ("agent_id", "manager_id") SELECT "id", "reports_to" FROM "agents" WHERE "reports_to" IS NOT NULL;
