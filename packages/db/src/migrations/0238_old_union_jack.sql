ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_kind_check";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_subject_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_credential_policy_check";--> statement-breakpoint
ALTER TABLE "connection_grants" ADD COLUMN "subject_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD COLUMN "subject_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD CONSTRAINT "tool_oauth_states_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_grants_subject_agent_idx" ON "connection_grants" USING btree ("company_id","subject_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_grants_agent_uq" ON "connection_grants" USING btree ("connection_id","subject_agent_id");--> statement-breakpoint
CREATE INDEX "tool_oauth_states_subject_agent_idx" ON "tool_oauth_states" USING btree ("company_id","subject_agent_id");--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user', 'agent'));--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null and "connection_grants"."subject_agent_id" is null) or ("connection_grants"."kind" = 'agent' and "connection_grants"."subject_agent_id" is not null and "connection_grants"."subject_user_id" is null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null and "connection_grants"."subject_agent_id" is null));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback', 'per_agent'));