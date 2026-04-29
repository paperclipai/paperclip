ALTER TABLE "agents" ADD COLUMN "org_level" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "primary_workflow_role" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "specialty" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "default_review_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "default_qa_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "workflow_role" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "review_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "qa_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "source_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "completion_requires" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_review_agent_id_agents_id_fk" FOREIGN KEY ("default_review_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_qa_agent_id_agents_id_fk" FOREIGN KEY ("default_qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_review_agent_id_agents_id_fk" FOREIGN KEY ("review_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_qa_agent_id_agents_id_fk" FOREIGN KEY ("qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;