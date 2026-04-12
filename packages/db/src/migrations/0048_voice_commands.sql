CREATE TABLE "voice_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"router_agent_id" uuid,
	"initiated_by_user_id" text NOT NULL,
	"raw_text" text NOT NULL,
	"classification" text,
	"action_taken" text,
	"created_issue_id" uuid,
	"chat_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"correction_history" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_commands" ADD CONSTRAINT "voice_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "voice_commands" ADD CONSTRAINT "voice_commands_router_agent_id_agents_id_fk" FOREIGN KEY ("router_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "voice_commands" ADD CONSTRAINT "voice_commands_created_issue_id_issues_id_fk" FOREIGN KEY ("created_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "voice_commands" ADD CONSTRAINT "voice_commands_chat_id_agent_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."agent_chats"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "voice_commands_company_user_idx" ON "voice_commands" USING btree ("company_id","initiated_by_user_id");
--> statement-breakpoint
CREATE INDEX "voice_commands_company_created_idx" ON "voice_commands" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "voice_commands_company_status_idx" ON "voice_commands" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "voice_commands_created_issue_idx" ON "voice_commands" USING btree ("created_issue_id");
