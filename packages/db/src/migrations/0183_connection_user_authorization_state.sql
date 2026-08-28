ALTER TABLE "tool_oauth_states" ADD COLUMN "subject_user_id" text;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD COLUMN "requested_scopes" jsonb;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD COLUMN "return_to" text;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD COLUMN "interaction_id" uuid;--> statement-breakpoint
CREATE INDEX "tool_oauth_states_subject_user_idx" ON "tool_oauth_states" USING btree ("company_id", "subject_user_id");
