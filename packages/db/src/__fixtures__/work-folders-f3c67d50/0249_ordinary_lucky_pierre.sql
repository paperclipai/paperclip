CREATE TABLE "work_folder_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid,
	"repository_binding_id" uuid,
	"provider" text NOT NULL,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "work_folder_objects_cleanup_idx" ON "work_folder_objects" USING btree ("provider","delete_after");