ALTER TABLE "case_handoffs" DROP CONSTRAINT IF EXISTS "case_handoffs_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
