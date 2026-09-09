CREATE TABLE "issue_question_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_question_drafts" ADD CONSTRAINT "issue_question_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_question_drafts" ADD CONSTRAINT "issue_question_drafts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_question_drafts" ADD CONSTRAINT "issue_question_drafts_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_question_drafts_company_issue_idx" ON "issue_question_drafts" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_question_drafts_company_interaction_user_uq" ON "issue_question_drafts" USING btree ("company_id","interaction_id","user_id");