CREATE TABLE "instance_retention_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"succeeded_run_retention_hours" integer DEFAULT 72 NOT NULL,
	"failed_run_retention_hours" integer DEFAULT 168 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "instance_retention_config" ADD CONSTRAINT "instance_retention_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;