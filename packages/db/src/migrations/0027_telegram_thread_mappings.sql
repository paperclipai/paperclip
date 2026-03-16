CREATE TABLE "telegram_thread_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"message_thread_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_thread_mappings" ADD CONSTRAINT "telegram_thread_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "telegram_thread_mappings" ADD CONSTRAINT "telegram_thread_mappings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_thread_mappings_issue_idx" ON "telegram_thread_mappings" USING btree ("issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_thread_mappings_chat_thread_idx" ON "telegram_thread_mappings" USING btree ("chat_id","message_thread_id");
