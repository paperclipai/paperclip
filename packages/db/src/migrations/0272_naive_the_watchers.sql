-- Earlier preview builds created these tables under unpublished migration numbers.
-- Keep their rows and content/checkpoint references when upgrading to master.
CREATE TABLE IF NOT EXISTS "task_repository_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"repo_url" text,
	"repo_ref" text,
	"setup_complete" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"checkpoint_key" text,
	"checkpoint_sha256" text,
	"checkpoint_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_repository_bindings_workspace_uq" UNIQUE("company_id","task_id","workspace_id"),
	CONSTRAINT "task_repository_bindings_name_uq" UNIQUE("company_id","task_id","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_file_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_file_operations_receipt_uq" UNIQUE("folder_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text DEFAULT 'file' NOT NULL,
	"object_key" text,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_folder_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid,
	"repository_binding_id" uuid,
	"provider" text NOT NULL,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_folder_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"baselines" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_operations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"last_saved_at" timestamp with time zone,
	"error" text,
	"refresh_requested" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_folders_owner_uq" UNIQUE("company_id","scope","owner_id"),
	CONSTRAINT "work_folders_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.task_repository_bindings'::regclass AND conname = left('task_repository_bindings_company_id_companies_id_fk', 63)) THEN
    ALTER TABLE "task_repository_bindings" ADD CONSTRAINT "task_repository_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.task_repository_bindings'::regclass AND conname = left('task_repository_bindings_task_id_issues_id_fk', 63)) THEN
    ALTER TABLE "task_repository_bindings" ADD CONSTRAINT "task_repository_bindings_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.work_file_operations'::regclass AND conname = left('work_file_operations_company_id_folder_id_work_folders_company_id_id_fk', 63)) THEN
    ALTER TABLE "work_file_operations" ADD CONSTRAINT "work_file_operations_company_id_folder_id_work_folders_company_id_id_fk" FOREIGN KEY ("company_id","folder_id") REFERENCES "public"."work_folders"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.work_files'::regclass AND conname = left('work_files_company_id_folder_id_work_folders_company_id_id_fk', 63)) THEN
    ALTER TABLE "work_files" ADD CONSTRAINT "work_files_company_id_folder_id_work_folders_company_id_id_fk" FOREIGN KEY ("company_id","folder_id") REFERENCES "public"."work_folders"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.work_folder_runs'::regclass AND conname = left('work_folder_runs_run_id_heartbeat_runs_id_fk', 63)) THEN
    ALTER TABLE "work_folder_runs" ADD CONSTRAINT "work_folder_runs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.work_folder_runs'::regclass AND conname = left('work_folder_runs_company_id_companies_id_fk', 63)) THEN
    ALTER TABLE "work_folder_runs" ADD CONSTRAINT "work_folder_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.work_folders'::regclass AND conname = left('work_folders_company_id_companies_id_fk', 63)) THEN
    ALTER TABLE "work_folders" ADD CONSTRAINT "work_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_files_folder_path_uq" ON "work_files" USING btree ("folder_id","path") WHERE "work_files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_files_company_folder_idx" ON "work_files" USING btree ("company_id","folder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_folder_objects_cleanup_idx" ON "work_folder_objects" USING btree ("provider","delete_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_folder_runs_company_idx" ON "work_folder_runs" USING btree ("company_id");
--> statement-breakpoint
ALTER TABLE "work_folder_runs" ADD COLUMN IF NOT EXISTS "baselines" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "work_folder_runs" ADD COLUMN IF NOT EXISTS "pending_operations" jsonb DEFAULT '{}'::jsonb NOT NULL;
