CREATE TABLE "awaiting_human_bridges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "interaction_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "status" text DEFAULT 'pending_delivery' NOT NULL,
  "close_outcome" text,
  "external_thread_id" text,
  "external_message_id" text,
  "next_poll_at" timestamp with time zone,
  "last_polled_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "close_reason" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "awaiting_human_bridge_inbound_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bridge_id" uuid NOT NULL,
  "interaction_id" uuid NOT NULL,
  "event_kind" text NOT NULL,
  "external_event_id" text,
  "external_message_id" text,
  "external_thread_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "awaiting_human_bridges" ADD CONSTRAINT "awaiting_human_bridges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "awaiting_human_bridges" ADD CONSTRAINT "awaiting_human_bridges_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "awaiting_human_bridges" ADD CONSTRAINT "awaiting_human_bridges_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "awaiting_human_bridges" ADD CONSTRAINT "awaiting_human_bridges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "awaiting_human_bridge_inbound_events" ADD CONSTRAINT "awaiting_human_bridge_inbound_events_bridge_id_awaiting_human_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."awaiting_human_bridges"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "awaiting_human_bridge_inbound_events" ADD CONSTRAINT "awaiting_human_bridge_inbound_events_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "awaiting_human_bridges_interaction_status_idx" ON "awaiting_human_bridges" USING btree ("interaction_id", "status");
--> statement-breakpoint
CREATE INDEX "awaiting_human_bridges_company_poll_idx" ON "awaiting_human_bridges" USING btree ("company_id", "status", "next_poll_at");
--> statement-breakpoint
CREATE INDEX "awaiting_human_bridge_inbound_events_bridge_created_at_idx" ON "awaiting_human_bridge_inbound_events" USING btree ("bridge_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "awaiting_human_bridge_inbound_events_interaction_event_uq" ON "awaiting_human_bridge_inbound_events" USING btree ("interaction_id", "external_event_id") WHERE "external_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "awaiting_human_bridges_interaction_active_uq" ON "awaiting_human_bridges" USING btree ("interaction_id") WHERE "status" IN ('pending_delivery', 'waiting_for_human');
