CREATE TABLE "plugin_issue_create_idempotency" (
	"company_id" uuid NOT NULL,
	"key_digest" text NOT NULL,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_issue_create_idempotency_pk" PRIMARY KEY("company_id","key_digest")
);
--> statement-breakpoint
ALTER TABLE "plugin_issue_create_idempotency" ADD CONSTRAINT "plugin_issue_create_idempotency_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_issue_create_idempotency" ADD CONSTRAINT "plugin_issue_create_idempotency_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
