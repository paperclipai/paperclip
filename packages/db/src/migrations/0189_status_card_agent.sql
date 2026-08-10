ALTER TABLE "status_cards" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
