CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text DEFAULT 'git' NOT NULL,
	"repository" text NOT NULL,
	"source_path" text,
	"default_ref" text DEFAULT 'main' NOT NULL,
	"mount_path" text NOT NULL,
	"credential_ref" text,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "resources_company_key_uq" ON "resources" USING btree ("company_id","key") WHERE "resources"."status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "resources_company_mount_path_uq" ON "resources" USING btree ("company_id","mount_path") WHERE "resources"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "resources_company_status_idx" ON "resources" USING btree ("company_id","status");
