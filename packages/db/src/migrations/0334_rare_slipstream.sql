CREATE TABLE "company_skill_repository_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"file_inventory" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "package_mode" text DEFAULT 'skills' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "repository_package" jsonb;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN "repository_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN "repository_skill_path" text;--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD CONSTRAINT "company_skill_repository_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_repository_snapshots_content_idx" ON "company_skill_repository_snapshots" USING btree ("company_id","content_hash");--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_repository_snapshot_id_company_skill_repository_snapshots_id_fk" FOREIGN KEY ("repository_snapshot_id") REFERENCES "public"."company_skill_repository_snapshots"("id") ON DELETE restrict ON UPDATE no action;