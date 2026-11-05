ALTER TABLE "issue_comments" ADD COLUMN "on_behalf_of_user_id" text;--> statement-breakpoint
UPDATE "issue_comments" c
SET "on_behalf_of_user_id" = hr."responsible_user_id"
FROM "heartbeat_runs" hr
JOIN "user" u ON u."id" = hr."responsible_user_id"
WHERE c."created_by_run_id" = hr."id"
	AND c."company_id" = hr."company_id"
	AND c."author_agent_id" = hr."agent_id"
	AND c."on_behalf_of_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_on_behalf_of_user_id_user_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
