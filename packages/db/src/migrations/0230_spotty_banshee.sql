CREATE TABLE IF NOT EXISTS "issue_user_recency" (
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"last_interacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "issue_user_recency_user_company_issue_pk" PRIMARY KEY("user_id","company_id","issue_id"),
	CONSTRAINT "issue_user_recency_kind_check" CHECK ("issue_user_recency"."kind" in ('created', 'commented', 'interaction', 'approval', 'edited', 'document'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_user_recency" ADD CONSTRAINT "issue_user_recency_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_user_recency" ADD CONSTRAINT "issue_user_recency_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_user_recency_company_user_recent_idx" ON "issue_user_recency" USING btree ("company_id","user_id","last_interacted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_user_recency_company_issue_idx" ON "issue_user_recency" USING btree ("company_id","issue_id");
