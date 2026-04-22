CREATE TABLE "context_source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"uri" text,
	"mime_type" text,
	"body_text" text,
	"body_sha256" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"status_message" text,
	"metadata" jsonb,
	"source_modified_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_source_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"item_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "context_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"provider" text,
	"title" text NOT NULL,
	"uri" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"status_message" text,
	"asset_id" uuid,
	"external_id" text,
	"metadata" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_context_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_markdown" text DEFAULT '' NOT NULL,
	"instructions_markdown" text DEFAULT '' NOT NULL,
	"default_skill_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retrieval_enabled" boolean DEFAULT true NOT NULL,
	"max_bundle_chars" integer DEFAULT 12000 NOT NULL,
	"max_chunks" integer DEFAULT 8 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_quick_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"site_name" text,
	"description" text,
	"image_url" text,
	"favicon_url" text,
	"metadata_fetched_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_source_chunks" ADD CONSTRAINT "context_source_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_chunks" ADD CONSTRAINT "context_source_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_chunks" ADD CONSTRAINT "context_source_chunks_source_id_context_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_chunks" ADD CONSTRAINT "context_source_chunks_item_id_context_source_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."context_source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_items" ADD CONSTRAINT "context_source_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_items" ADD CONSTRAINT "context_source_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_items" ADD CONSTRAINT "context_source_items_source_id_context_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_sync_runs" ADD CONSTRAINT "context_source_sync_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_sync_runs" ADD CONSTRAINT "context_source_sync_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_source_sync_runs" ADD CONSTRAINT "context_source_sync_runs_source_id_context_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_context_profiles" ADD CONSTRAINT "project_context_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_context_profiles" ADD CONSTRAINT "project_context_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD CONSTRAINT "project_quick_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD CONSTRAINT "project_quick_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD CONSTRAINT "project_quick_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_source_chunks_company_project_idx" ON "context_source_chunks" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "context_source_chunks_source_idx" ON "context_source_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_source_chunks_item_chunk_uq" ON "context_source_chunks" USING btree ("item_id","chunk_index");--> statement-breakpoint
CREATE INDEX "context_source_chunks_content_search_idx" ON "context_source_chunks" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "context_source_items_company_project_idx" ON "context_source_items" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "context_source_items_source_idx" ON "context_source_items" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_source_items_source_external_uq" ON "context_source_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "context_source_sync_runs_source_started_idx" ON "context_source_sync_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "context_source_sync_runs_company_project_idx" ON "context_source_sync_runs" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "context_sources_company_project_idx" ON "context_sources" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "context_sources_project_status_idx" ON "context_sources" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "context_sources_external_idx" ON "context_sources" USING btree ("company_id","source_type","external_id");--> statement-breakpoint
CREATE INDEX "issue_links_company_issue_position_idx" ON "issue_links" USING btree ("company_id","issue_id","position");--> statement-breakpoint
CREATE INDEX "issue_links_issue_idx" ON "issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_context_profiles_project_uq" ON "project_context_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_context_profiles_company_project_idx" ON "project_context_profiles" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "project_quick_links_company_project_position_idx" ON "project_quick_links" USING btree ("company_id","project_id","position");--> statement-breakpoint
CREATE INDEX "project_quick_links_project_updated_idx" ON "project_quick_links" USING btree ("project_id","updated_at");