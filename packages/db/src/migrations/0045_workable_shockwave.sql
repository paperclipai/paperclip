CREATE TABLE "issue_inbox_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "board_api_keys_key_hash_idx";--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_inbox_archives_company_issue_idx" ON "issue_inbox_archives" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_inbox_archives_company_user_idx" ON "issue_inbox_archives" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_inbox_archives_company_issue_user_idx" ON "issue_inbox_archives" USING btree ("company_id","issue_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");