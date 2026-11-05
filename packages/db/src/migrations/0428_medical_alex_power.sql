CREATE TABLE "task_provider_output_policies" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_provider_output_policies_disposition_check" CHECK ("task_provider_output_policies"."disposition" in ('ordinary', 'forbidden'))
);
--> statement-breakpoint
ALTER TABLE "task_provider_output_policies" ADD CONSTRAINT "task_provider_output_policies_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
LOCK TABLE "chat_conversations" IN SHARE MODE;
--> statement-breakpoint
INSERT INTO "task_provider_output_policies" ("company_id", "issue_id", "disposition")
SELECT DISTINCT "company_id", "issue_id", 'forbidden'
FROM "chat_conversations";