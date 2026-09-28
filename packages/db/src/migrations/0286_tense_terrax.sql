CREATE TABLE "execution_grant_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"steward_agent_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_grant_policies" ADD CONSTRAINT "execution_grant_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_grant_policies" ADD CONSTRAINT "execution_grant_policies_steward_agent_id_agents_id_fk" FOREIGN KEY ("steward_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;