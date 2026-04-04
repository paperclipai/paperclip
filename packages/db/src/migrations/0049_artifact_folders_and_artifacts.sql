CREATE TABLE "artifact_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"mime_type" text NOT NULL,
	"issue_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_folder_id_artifact_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."artifact_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_folders_company_path_uq" ON "artifact_folders" USING btree ("company_id","path");--> statement-breakpoint
CREATE INDEX "artifact_folders_company_parent_idx" ON "artifact_folders" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE INDEX "artifact_folders_company_source_idx" ON "artifact_folders" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_folder_idx" ON "artifacts" USING btree ("company_id","folder_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_issue_idx" ON "artifacts" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_agent_idx" ON "artifacts" USING btree ("company_id","created_by_agent_id");