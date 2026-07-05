CREATE TABLE IF NOT EXISTS "issue_favourites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_favourites" ADD CONSTRAINT "issue_favourites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_favourites" ADD CONSTRAINT "issue_favourites_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_favourites_company_user_idx" ON "issue_favourites" ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_favourites_company_issue_idx" ON "issue_favourites" ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_favourites_company_issue_user_idx" ON "issue_favourites" ("company_id","issue_id","user_id");
