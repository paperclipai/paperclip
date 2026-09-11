ALTER TABLE "issue_comments" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "conversation_session_generation" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_state" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_session_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_boundary_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_agent_id_agents_id_fk" FOREIGN KEY ("conversation_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_conversation_identity_idx" ON "issues" USING btree ("company_id","conversation_agent_id","conversation_user_id");--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_client_request_uq" UNIQUE("issue_id","author_user_id","client_request_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_identity_check" CHECK ((
      "issues"."conversation_agent_id" is null and "issues"."conversation_user_id" is null and "issues"."conversation_state" is null
    ) or (
      "issues"."conversation_agent_id" is not null and "issues"."conversation_user_id" is not null
      and "issues"."assignee_agent_id" = "issues"."conversation_agent_id" and "issues"."assignee_agent_id" is not null
      and "issues"."assignee_user_id" is null and "issues"."conversation_state" in ('active', 'waiting')
      and "issues"."status" not in ('done', 'cancelled')
    ));