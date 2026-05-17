CREATE TABLE "clip_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid,
	"creator_profile_id" uuid,
	"author_user_id" text,
	"author_agent_id" uuid,
	"scope" text DEFAULT 'clip' NOT NULL,
	"category" text DEFAULT 'question' NOT NULL,
	"moderation_state" text DEFAULT 'normal' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_creator_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"avatar_url" text,
	"website_url" text,
	"verification_state" text DEFAULT 'unverified' NOT NULL,
	"reputation_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text,
	"required" text DEFAULT 'required' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid,
	"reporter_type" text DEFAULT 'anonymous' NOT NULL,
	"reporter_id" text,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_imported_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_import_id" uuid NOT NULL,
	"destination_object_type" text NOT NULL,
	"destination_object_id" text NOT NULL,
	"package_path" text,
	"action" text NOT NULL,
	"local_fingerprint" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_company_id" uuid NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"manifest_checksum" text NOT NULL,
	"artifact_checksum" text NOT NULL,
	"source_url" text,
	"revision_url" text,
	"status" text DEFAULT 'previewed' NOT NULL,
	"imported_by_user_id" text,
	"imported_by_agent_id" uuid,
	"collision_strategy" text,
	"selected_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_run_validation_state" text DEFAULT 'not_run' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_public_metric_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid,
	"event_type" text NOT NULL,
	"actor_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_ranking_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"manifest_version" text DEFAULT 'paperclip.clip/v1' NOT NULL,
	"manifest_checksum" text NOT NULL,
	"artifact_checksum" text NOT NULL,
	"manifest_payload" jsonb NOT NULL,
	"artifact_ref" jsonb,
	"dependency_graph" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secrets_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_estimate" jsonb,
	"redaction_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dangerous_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_review_state" text DEFAULT 'unreviewed' NOT NULL,
	"verification_state" text DEFAULT 'not_run' NOT NULL,
	"compatibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_summary" text,
	"breaking_changes" text,
	"migration_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_showcase_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"creator_profile_id" uuid,
	"author_user_id" text,
	"author_agent_id" uuid,
	"type" text DEFAULT 'community_example' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"media_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_state" text DEFAULT 'not_run' NOT NULL,
	"moderation_state" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"vote" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_company_id" uuid NOT NULL,
	"creator_profile_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'unlisted' NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"moderation_state" text DEFAULT 'normal' NOT NULL,
	"current_revision_id" uuid,
	"latest_approved_revision_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"use_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compatibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" text,
	"source_object_type" text,
	"source_object_id" text,
	"import_count" integer DEFAULT 0 NOT NULL,
	"successful_first_run_count" integer DEFAULT 0 NOT NULL,
	"vote_score" integer DEFAULT 0 NOT NULL,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"downvote_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"showcase_count" integer DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delisted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clip_comments" ADD CONSTRAINT "clip_comments_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_comments" ADD CONSTRAINT "clip_comments_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_comments" ADD CONSTRAINT "clip_comments_creator_profile_id_clip_creator_profiles_id_fk" FOREIGN KEY ("creator_profile_id") REFERENCES "public"."clip_creator_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_creator_profiles" ADD CONSTRAINT "clip_creator_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_dependencies" ADD CONSTRAINT "clip_dependencies_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_dependencies" ADD CONSTRAINT "clip_dependencies_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_flags" ADD CONSTRAINT "clip_flags_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_flags" ADD CONSTRAINT "clip_flags_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_imported_objects" ADD CONSTRAINT "clip_imported_objects_clip_import_id_clip_imports_id_fk" FOREIGN KEY ("clip_import_id") REFERENCES "public"."clip_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_imports" ADD CONSTRAINT "clip_imports_destination_company_id_companies_id_fk" FOREIGN KEY ("destination_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_imports" ADD CONSTRAINT "clip_imports_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_imports" ADD CONSTRAINT "clip_imports_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_moderation_events" ADD CONSTRAINT "clip_moderation_events_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_moderation_events" ADD CONSTRAINT "clip_moderation_events_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_public_metric_events" ADD CONSTRAINT "clip_public_metric_events_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_public_metric_events" ADD CONSTRAINT "clip_public_metric_events_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_ranking_snapshots" ADD CONSTRAINT "clip_ranking_snapshots_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_revisions" ADD CONSTRAINT "clip_revisions_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_showcase_posts" ADD CONSTRAINT "clip_showcase_posts_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_showcase_posts" ADD CONSTRAINT "clip_showcase_posts_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_showcase_posts" ADD CONSTRAINT "clip_showcase_posts_creator_profile_id_clip_creator_profiles_id_fk" FOREIGN KEY ("creator_profile_id") REFERENCES "public"."clip_creator_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_votes" ADD CONSTRAINT "clip_votes_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_votes" ADD CONSTRAINT "clip_votes_revision_id_clip_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."clip_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_creator_profile_id_clip_creator_profiles_id_fk" FOREIGN KEY ("creator_profile_id") REFERENCES "public"."clip_creator_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_comments_clip_created_idx" ON "clip_comments" USING btree ("clip_id","created_at");--> statement-breakpoint
CREATE INDEX "clip_comments_revision_idx" ON "clip_comments" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "clip_creator_profiles_company_idx" ON "clip_creator_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_creator_profiles_handle_uq" ON "clip_creator_profiles" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "clip_dependencies_revision_idx" ON "clip_dependencies" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "clip_dependencies_type_key_idx" ON "clip_dependencies" USING btree ("type","key");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_dependencies_revision_type_key_uq" ON "clip_dependencies" USING btree ("revision_id","type","key");--> statement-breakpoint
CREATE INDEX "clip_flags_clip_status_idx" ON "clip_flags" USING btree ("clip_id","status");--> statement-breakpoint
CREATE INDEX "clip_flags_revision_idx" ON "clip_flags" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "clip_imported_objects_import_idx" ON "clip_imported_objects" USING btree ("clip_import_id");--> statement-breakpoint
CREATE INDEX "clip_imported_objects_destination_idx" ON "clip_imported_objects" USING btree ("destination_object_type","destination_object_id");--> statement-breakpoint
CREATE INDEX "clip_imports_destination_idx" ON "clip_imports" USING btree ("destination_company_id","created_at");--> statement-breakpoint
CREATE INDEX "clip_imports_revision_idx" ON "clip_imports" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "clip_moderation_events_clip_created_idx" ON "clip_moderation_events" USING btree ("clip_id","created_at");--> statement-breakpoint
CREATE INDEX "clip_public_metric_events_clip_event_idx" ON "clip_public_metric_events" USING btree ("clip_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "clip_ranking_snapshots_scope_score_idx" ON "clip_ranking_snapshots" USING btree ("scope","score");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_ranking_snapshots_clip_scope_uq" ON "clip_ranking_snapshots" USING btree ("clip_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_revisions_clip_revision_uq" ON "clip_revisions" USING btree ("clip_id","revision_number");--> statement-breakpoint
CREATE INDEX "clip_revisions_clip_created_idx" ON "clip_revisions" USING btree ("clip_id","created_at");--> statement-breakpoint
CREATE INDEX "clip_revisions_manifest_checksum_idx" ON "clip_revisions" USING btree ("manifest_checksum");--> statement-breakpoint
CREATE INDEX "clip_showcase_posts_clip_created_idx" ON "clip_showcase_posts" USING btree ("clip_id","created_at");--> statement-breakpoint
CREATE INDEX "clip_showcase_posts_revision_idx" ON "clip_showcase_posts" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "clip_votes_revision_idx" ON "clip_votes" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_votes_revision_actor_uq" ON "clip_votes" USING btree ("revision_id","actor_type","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clips_slug_uq" ON "clips" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "clips_source_company_idx" ON "clips" USING btree ("source_company_id");--> statement-breakpoint
CREATE INDEX "clips_creator_idx" ON "clips" USING btree ("creator_profile_id");--> statement-breakpoint
CREATE INDEX "clips_public_browse_idx" ON "clips" USING btree ("visibility","status","moderation_state","updated_at");--> statement-breakpoint
CREATE INDEX "clips_type_idx" ON "clips" USING btree ("type");--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_clip_revision_update()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'clip_revisions are immutable; publish a new revision instead';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER prevent_clip_revision_update_trigger
BEFORE UPDATE ON "clip_revisions"
FOR EACH ROW EXECUTE FUNCTION prevent_clip_revision_update();
