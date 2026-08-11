CREATE TABLE "database_backup_execution_fence" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"owner_token" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
