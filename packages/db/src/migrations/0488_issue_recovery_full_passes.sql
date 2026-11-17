CREATE TABLE "issue_recovery_deferrals" (
	"queue" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_recovery_deferrals_pk" PRIMARY KEY("queue","issue_id")
);
--> statement-breakpoint
CREATE TABLE "issue_recovery_full_passes" (
	"company_id" uuid NOT NULL,
	"queue" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_recovery_full_passes_pk" PRIMARY KEY("company_id","queue")
);
--> statement-breakpoint
ALTER TABLE "issue_recovery_deferrals" ADD CONSTRAINT "issue_recovery_deferrals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_deferrals" ADD CONSTRAINT "issue_recovery_deferrals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_full_passes" ADD CONSTRAINT "issue_recovery_full_passes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;