ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "channels_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"topic" text,
	"project_id" uuid,
	"dm_fingerprint" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"last_read_at" timestamp with time zone,
	"last_read_message_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text,
	"message_type" text DEFAULT 'user' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"thread_root_id" uuid,
	"reply_to_id" uuid,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"work_product_id" uuid,
	"interaction_id" uuid,
	"approval_id" uuid,
	"document_id" uuid,
	"card_kind" text,
	"channel_work_mode" text,
	"mentioned_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mentioned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channels" ADD CONSTRAINT "channels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channels" ADD CONSTRAINT "channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_company_idx" ON "channels" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_company_slug_uidx" ON "channels" USING btree ("company_id","slug") WHERE "channels"."slug" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_company_project_uidx" ON "channels" USING btree ("company_id","project_id") WHERE "channels"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_company_dm_uidx" ON "channels" USING btree ("company_id","dm_fingerprint") WHERE "channels"."dm_fingerprint" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_members_channel_idx" ON "channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_members_company_idx" ON "channel_members" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_members_principal_uidx" ON "channel_members" USING btree ("channel_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_channel_created_idx" ON "channel_messages" USING btree ("channel_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_company_idx" ON "channel_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_roots_idx" ON "channel_messages" USING btree ("channel_id","created_at","id") WHERE "channel_messages"."thread_root_id" is null and "channel_messages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_thread_idx" ON "channel_messages" USING btree ("thread_root_id","created_at","id") WHERE "channel_messages"."thread_root_id" is not null and "channel_messages"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_messages_issue_root_uidx" ON "channel_messages" USING btree ("issue_id") WHERE "channel_messages"."issue_id" is not null and "channel_messages"."thread_root_id" is null and "channel_messages"."deleted_at" is null and "channel_messages"."card_kind" = 'task';
