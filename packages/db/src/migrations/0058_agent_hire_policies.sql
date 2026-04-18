CREATE TABLE "agent_hire_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"allowed_combinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_hires_per_minute" integer,
	"max_hires_per_hour" integer,
	"notes" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_hire_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_hire_policies" ADD CONSTRAINT "agent_hire_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_policies" ADD CONSTRAINT "agent_hire_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_events" ADD CONSTRAINT "agent_hire_events_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_hire_events" ADD CONSTRAINT "agent_hire_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_hire_policies_agent_unique_idx" ON "agent_hire_policies" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_hire_events_caller_created_idx" ON "agent_hire_events" USING btree ("caller_agent_id","created_at");
