CREATE TABLE "agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"vault_ref" text,
	"ttl_seconds" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid,
	"message_type" text DEFAULT 'text' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"payload" jsonb,
	"parent_message_id" uuid,
	"reference_type" text,
	"reference_id" uuid,
	"priority" text DEFAULT 'normal' NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consensus_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"proposal_type" text DEFAULT 'action' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"proposer_agent_id" uuid,
	"proposer_user_id" text,
	"quorum_type" text DEFAULT 'majority' NOT NULL,
	"quorum_min_votes" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"knowledge_entry_id" uuid,
	"votes_for" integer DEFAULT 0 NOT NULL,
	"votes_against" integer DEFAULT 0 NOT NULL,
	"votes_abstain" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"vetoed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consensus_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"vote" text NOT NULL,
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"vault_ref" text,
	"author_agent_id" uuid,
	"author_user_id" text,
	"version" text DEFAULT '1' NOT NULL,
	"ratified_by_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consensus_proposals" ADD CONSTRAINT "consensus_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consensus_proposals" ADD CONSTRAINT "consensus_proposals_proposer_agent_id_agents_id_fk" FOREIGN KEY ("proposer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consensus_votes" ADD CONSTRAINT "consensus_votes_proposal_id_consensus_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."consensus_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consensus_votes" ADD CONSTRAINT "consensus_votes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memory_agent_idx" ON "agent_memory" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_memory_company_idx" ON "agent_memory" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_agent_key_uq" ON "agent_memory" USING btree ("agent_id","key");--> statement-breakpoint
CREATE INDEX "agent_memory_expires_idx" ON "agent_memory" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_messages_company_idx" ON "agent_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_messages_from_agent_idx" ON "agent_messages" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "agent_messages_to_agent_idx" ON "agent_messages" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "agent_messages_channel_idx" ON "agent_messages" USING btree ("company_id","channel");--> statement-breakpoint
CREATE INDEX "agent_messages_parent_idx" ON "agent_messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "agent_messages_created_at_idx" ON "agent_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "consensus_proposals_company_idx" ON "consensus_proposals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "consensus_proposals_company_status_idx" ON "consensus_proposals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "consensus_proposals_proposer_idx" ON "consensus_proposals" USING btree ("proposer_agent_id");--> statement-breakpoint
CREATE INDEX "consensus_proposals_expires_idx" ON "consensus_proposals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "consensus_votes_proposal_idx" ON "consensus_votes" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "consensus_votes_agent_idx" ON "consensus_votes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "knowledge_entries_company_idx" ON "knowledge_entries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "knowledge_entries_company_category_idx" ON "knowledge_entries" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX "knowledge_entries_company_status_idx" ON "knowledge_entries" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_entries_author_agent_idx" ON "knowledge_entries" USING btree ("author_agent_id");