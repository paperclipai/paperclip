ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_conversation_identity_check";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_identity_check" CHECK ((
      "issues"."conversation_agent_id" is null and "issues"."conversation_user_id" is null and "issues"."conversation_state" is null
    ) or (
      "issues"."conversation_agent_id" is not null and "issues"."conversation_user_id" is not null
      and "issues"."assignee_agent_id" = "issues"."conversation_agent_id" and "issues"."assignee_agent_id" is not null
      and "issues"."assignee_user_id" is null and "issues"."conversation_state" is not null
      and "issues"."conversation_state" in ('active', 'waiting')
      and "issues"."status" not in ('done', 'cancelled')
    ));