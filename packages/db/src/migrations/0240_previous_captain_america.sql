CREATE TABLE "chat_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"delivery_id" uuid,
	"conversation_id" uuid,
	"principal_id" uuid,
	"kind" text NOT NULL,
	"provider_action_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_agent_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_endpoint_id" uuid NOT NULL,
	"destination_endpoint_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_mode" text DEFAULT 'explicit_mention' NOT NULL,
	"max_hops" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_agent_routes_hops_check" CHECK ("chat_agent_routes"."max_hops" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"resource_id" uuid,
	"issue_id" uuid NOT NULL,
	"external_conversation_id" text NOT NULL,
	"external_thread_id" text DEFAULT '' NOT NULL,
	"external_label" text NOT NULL,
	"provider_url" text,
	"is_direct_message" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_conversations_state_check" CHECK ("chat_conversations"."state" in ('active', 'waiting', 'completed', 'unavailable', 'endpoint_removed'))
);
--> statement-breakpoint
CREATE TABLE "chat_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid,
	"principal_id" uuid,
	"provider_event_id" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"event_kind" text NOT NULL,
	"normalized_event" jsonb NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"redacted_error" text,
	"next_attempt_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_deliveries_state_check" CHECK ("chat_deliveries"."state" in ('received', 'filtered', 'processing', 'processed', 'retry', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "chat_endpoint_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"lease_key" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_endpoint_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"parent_provider_resource_id" text,
	"label" text NOT NULL,
	"detail" text,
	"provider_url" text,
	"availability" text DEFAULT 'available' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_endpoint_resources_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_endpoint_resources_availability_check" CHECK ("chat_endpoint_resources"."availability" in ('available', 'unavailable', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "chat_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"public_id" text NOT NULL,
	"assigned_agent_id" uuid NOT NULL,
	"sponsor_user_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"deployment_mode" text DEFAULT 'direct' NOT NULL,
	"provider_account_id" text,
	"provider_account_label" text,
	"bot_external_id" text,
	"bot_username" text,
	"bot_display_name" text,
	"bot_avatar_url" text,
	"allow_direct_messages" boolean DEFAULT true NOT NULL,
	"allow_group_chats" boolean DEFAULT false NOT NULL,
	"allow_unlinked_people" boolean DEFAULT true NOT NULL,
	"concurrency_policy" text DEFAULT 'queue' NOT NULL,
	"capabilities" jsonb DEFAULT '{"threads":false,"directMessages":false,"nativeStreaming":false,"messageEdits":false,"messageDeletes":false,"reactions":false,"files":false,"cards":false,"actions":false,"modals":false,"slashCommands":false,"ephemeralMessages":false,"proactiveDirectMessages":false}'::jsonb NOT NULL,
	"setup" jsonb DEFAULT '{"step":"provider_setup"}'::jsonb NOT NULL,
	"health_message" text,
	"last_event_at" timestamp with time zone,
	"last_publication_at" timestamp with time zone,
	"last_error" text,
	"activated_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_endpoints_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'microsoft-teams', 'telegram')),
	CONSTRAINT "chat_endpoints_status_check" CHECK ("chat_endpoints"."status" in ('draft', 'verifying', 'active', 'paused', 'attention', 'revoked', 'archived')),
	CONSTRAINT "chat_endpoints_deployment_check" CHECK ("chat_endpoints"."deployment_mode" in ('direct', 'relay')),
	CONSTRAINT "chat_endpoints_concurrency_check" CHECK ("chat_endpoints"."concurrency_policy" in ('burst', 'queue', 'debounce', 'drop', 'concurrent'))
);
--> statement-breakpoint
CREATE TABLE "chat_external_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text DEFAULT 'user' NOT NULL,
	"display_name" text,
	"handle" text,
	"avatar_url" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_external_principals_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'microsoft-teams', 'telegram')),
	CONSTRAINT "chat_external_principals_kind_check" CHECK ("chat_external_principals"."kind" in ('user', 'bot', 'app', 'system'))
);
--> statement-breakpoint
CREATE TABLE "chat_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"paperclip_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmation_token_hash" text,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_identity_links_status_check" CHECK ("chat_identity_links"."status" in ('pending', 'linked', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "chat_message_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"delivery_id" uuid,
	"publication_id" uuid,
	"comment_id" uuid,
	"provider_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_links_direction_check" CHECK ("chat_message_links"."direction" in ('inbound', 'outbound'))
);
--> statement-breakpoint
CREATE TABLE "chat_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"provider_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"redacted_error" text,
	"next_attempt_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_publications_state_check" CHECK ("chat_publications"."state" in ('pending', 'streaming', 'published', 'retry', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "chat_sdk_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"state_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN "connection_purpose" text DEFAULT 'tool' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_delivery_id_chat_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."chat_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_actions" ADD CONSTRAINT "chat_actions_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_company_source_fk" FOREIGN KEY ("company_id","source_endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_company_destination_fk" FOREIGN KEY ("company_id","destination_endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_resource_fk" FOREIGN KEY ("company_id","resource_id") REFERENCES "public"."chat_endpoint_resources"("company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoint_leases" ADD CONSTRAINT "chat_endpoint_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoint_leases" ADD CONSTRAINT "chat_endpoint_leases_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoint_resources" ADD CONSTRAINT "chat_endpoint_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoint_resources" ADD CONSTRAINT "chat_endpoint_resources_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identity_links" ADD CONSTRAINT "chat_identity_links_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_delivery_id_chat_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."chat_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_publication_id_chat_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."chat_publications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_links" ADD CONSTRAINT "chat_message_links_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_publications" ADD CONSTRAINT "chat_publications_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sdk_state" ADD CONSTRAINT "chat_sdk_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sdk_state" ADD CONSTRAINT "chat_sdk_state_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_actions_provider_action_uq" ON "chat_actions" USING btree ("endpoint_id","provider_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_agent_routes_pair_uq" ON "chat_agent_routes" USING btree ("source_endpoint_id","destination_endpoint_id");--> statement-breakpoint
CREATE INDEX "chat_conversations_issue_idx" ON "chat_conversations" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_thread_uq" ON "chat_conversations" USING btree ("endpoint_id","external_conversation_id","external_thread_id");--> statement-breakpoint
CREATE INDEX "chat_deliveries_work_idx" ON "chat_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_deliveries_event_uq" ON "chat_deliveries" USING btree ("endpoint_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_deliveries_dedupe_uq" ON "chat_deliveries" USING btree ("endpoint_id","deduplication_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoint_leases_active_uq" ON "chat_endpoint_leases" USING btree ("endpoint_id","lease_key");--> statement-breakpoint
CREATE INDEX "chat_endpoint_leases_expiry_idx" ON "chat_endpoint_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_endpoint_resources_endpoint_idx" ON "chat_endpoint_resources" USING btree ("company_id","endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoint_resources_external_uq" ON "chat_endpoint_resources" USING btree ("endpoint_id","type","provider_resource_id");--> statement-breakpoint
CREATE INDEX "chat_endpoints_company_idx" ON "chat_endpoints" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "chat_endpoints_agent_idx" ON "chat_endpoints" USING btree ("company_id","assigned_agent_id");--> statement-breakpoint
CREATE INDEX "chat_endpoints_status_idx" ON "chat_endpoints" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoints_public_id_uq" ON "chat_endpoints" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoints_connection_uq" ON "chat_endpoints" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "chat_external_principals_company_idx" ON "chat_external_principals" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_external_principals_external_uq" ON "chat_external_principals" USING btree ("company_id","provider","provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "chat_identity_links_user_idx" ON "chat_identity_links" USING btree ("company_id","paperclip_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_identity_links_endpoint_principal_uq" ON "chat_identity_links" USING btree ("endpoint_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_links_provider_message_uq" ON "chat_message_links" USING btree ("endpoint_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "chat_publications_work_idx" ON "chat_publications" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_publications_idempotency_uq" ON "chat_publications" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sdk_state_key_uq" ON "chat_sdk_state" USING btree ("endpoint_id","state_key");--> statement-breakpoint
CREATE INDEX "chat_sdk_state_expiry_idx" ON "chat_sdk_state" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_purpose_check" CHECK ("tool_connections"."connection_purpose" in ('tool', 'channel'));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" <> 'chat_sdk')
      or
      ("tool_connections"."connection_purpose" = 'channel' and "tool_connections"."transport" = 'chat_sdk')
    ));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk'));
