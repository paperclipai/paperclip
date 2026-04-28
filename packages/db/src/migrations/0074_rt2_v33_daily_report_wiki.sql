CREATE TABLE "rt2_v33_daily_report_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"report_date" date NOT NULL,
	"task_issue_id" uuid NOT NULL,
	"todo_issue_id" uuid NOT NULL,
	"assignee_user_id" text NOT NULL,
	"task_title" text NOT NULL,
	"todo_title" text NOT NULL,
	"lane" text NOT NULL,
	"bucket_label" text,
	"progress_percent" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_daily_report_cards_lane_check" CHECK ("rt2_v33_daily_report_cards"."lane" in ('today', 'support_1', 'support_2')),
	CONSTRAINT "rt2_v33_daily_report_cards_progress_percent_check" CHECK ("rt2_v33_daily_report_cards"."progress_percent" between 0 and 100),
	CONSTRAINT "rt2_v33_daily_report_cards_status_check" CHECK ("rt2_v33_daily_report_cards"."status" in ('todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_daily_wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"report_date" date NOT NULL,
	"page_key" text NOT NULL,
	"short_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_daily_report_cards" ADD CONSTRAINT "rt2_v33_daily_report_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_daily_report_cards" ADD CONSTRAINT "rt2_v33_daily_report_cards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_daily_report_cards" ADD CONSTRAINT "rt2_v33_daily_report_cards_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_daily_report_cards" ADD CONSTRAINT "rt2_v33_daily_report_cards_todo_issue_id_issues_id_fk" FOREIGN KEY ("todo_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_daily_wiki_pages" ADD CONSTRAINT "rt2_v33_daily_wiki_pages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_daily_wiki_pages" ADD CONSTRAINT "rt2_v33_daily_wiki_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rt2_v33_daily_report_cards_company_project_lane_idx" ON "rt2_v33_daily_report_cards" USING btree ("company_id","project_id","user_id","report_date","lane");--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_daily_report_cards_company_project_todo_day_uq" ON "rt2_v33_daily_report_cards" USING btree ("company_id","project_id","user_id","report_date","todo_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_daily_wiki_pages_company_page_key_uq" ON "rt2_v33_daily_wiki_pages" USING btree ("company_id","page_key");--> statement-breakpoint
CREATE INDEX "rt2_v33_daily_wiki_pages_company_recent_idx" ON "rt2_v33_daily_wiki_pages" USING btree ("company_id","project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_daily_wiki_pages_company_project_user_report_date_uq" ON "rt2_v33_daily_wiki_pages" USING btree ("company_id","project_id","user_id","report_date");
