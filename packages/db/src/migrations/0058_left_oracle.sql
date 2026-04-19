CREATE TABLE "company_rollout_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_company_id" uuid NOT NULL,
	"target_company_id" uuid NOT NULL,
	"source_entity_kind" text NOT NULL,
	"source_entity_key" text NOT NULL,
	"source_entity_hash" text NOT NULL,
	"target_entity_type" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"release_id" uuid NOT NULL,
	"last_applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_rollout_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_company_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"manifest_json" jsonb NOT NULL,
	"files_json" jsonb NOT NULL,
	"selected_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"package_hash" text NOT NULL,
	"counts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_rollout_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"source_company_id" uuid NOT NULL,
	"target_company_id" uuid NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"counts_json" jsonb DEFAULT '{"create":0,"update":0,"skipNoChange":0,"skipUnmanagedConflict":0,"error":0}'::jsonb NOT NULL,
	"entity_actions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"apply_result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_rollout_entity_links" ADD CONSTRAINT "company_rollout_entity_links_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rollout_entity_links" ADD CONSTRAINT "company_rollout_entity_links_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rollout_entity_links" ADD CONSTRAINT "company_rollout_entity_links_release_id_company_rollout_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."company_rollout_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rollout_releases" ADD CONSTRAINT "company_rollout_releases_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rollout_targets" ADD CONSTRAINT "company_rollout_targets_release_id_company_rollout_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."company_rollout_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rollout_targets" ADD CONSTRAINT "company_rollout_targets_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rollout_targets" ADD CONSTRAINT "company_rollout_targets_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_rollout_entity_links_source_target_entity_uq" ON "company_rollout_entity_links" USING btree ("source_company_id","target_company_id","source_entity_kind","source_entity_key");--> statement-breakpoint
CREATE INDEX "company_rollout_entity_links_target_entity_idx" ON "company_rollout_entity_links" USING btree ("target_company_id","target_entity_type","target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_rollout_releases_source_version_uq" ON "company_rollout_releases" USING btree ("source_company_id","version");--> statement-breakpoint
CREATE INDEX "company_rollout_releases_source_created_idx" ON "company_rollout_releases" USING btree ("source_company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_rollout_targets_release_target_uq" ON "company_rollout_targets" USING btree ("release_id","target_company_id");--> statement-breakpoint
CREATE INDEX "company_rollout_targets_target_updated_idx" ON "company_rollout_targets" USING btree ("target_company_id","updated_at");