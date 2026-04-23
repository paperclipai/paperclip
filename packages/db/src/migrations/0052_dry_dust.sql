ALTER TABLE "agent_chats" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD COLUMN "anchor_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD CONSTRAINT "agent_chats_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD CONSTRAINT "agent_chats_anchor_comment_id_issue_comments_id_fk" FOREIGN KEY ("anchor_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_quick_chat_idx" ON "agent_chats" USING btree ("agent_id","anchor_comment_id") WHERE "agent_chats"."anchor_comment_id" is not null;