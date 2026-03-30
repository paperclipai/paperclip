CREATE TABLE "agent_telegram_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"bot_token" text NOT NULL,
	"bot_username" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"owner_chat_id" text,
	"allowed_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_mention" boolean DEFAULT true NOT NULL,
	"mention_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "telegram_chat_id" text;
--> statement-breakpoint
ALTER TABLE "agent_telegram_configs" ADD CONSTRAINT "agent_telegram_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_telegram_configs" ADD CONSTRAINT "agent_telegram_configs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_telegram_configs_agent_idx" ON "agent_telegram_configs" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_telegram_configs_company_idx" ON "agent_telegram_configs" USING btree ("company_id","agent_id");
