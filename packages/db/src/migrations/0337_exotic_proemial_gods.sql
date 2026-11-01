CREATE TABLE IF NOT EXISTS "execution_workspace_repository_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"canonical_cwd" text NOT NULL,
	"root_key" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $migration$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'execution_workspace_repository_roots'::regclass AND conname = 'execution_workspace_repository_roots_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "execution_workspace_repository_roots" ADD CONSTRAINT "execution_workspace_repository_roots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $migration$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspace_repository_roots_company_root_idx" ON "execution_workspace_repository_roots" USING btree ("company_id","root_key");
