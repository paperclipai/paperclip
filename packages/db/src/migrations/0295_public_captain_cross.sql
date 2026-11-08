CREATE TABLE IF NOT EXISTS "tool_connection_app_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"credential_key" text NOT NULL,
	"toolkit" text NOT NULL,
	"status" text NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tool_connection_app_snapshots" ADD CONSTRAINT "tool_connection_app_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tool_connection_app_snapshots" ADD CONSTRAINT "tool_connection_app_snapshots_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_connection_app_snapshots_owner_toolkit_uq" ON "tool_connection_app_snapshots" USING btree ("company_id","connection_id","user_id","toolkit");
