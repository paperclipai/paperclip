CREATE TABLE "issue_recovery_full_passes" (
	"company_id" uuid NOT NULL,
	"queue" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_recovery_full_passes_pk" PRIMARY KEY("company_id","queue")
);
--> statement-breakpoint
ALTER TABLE "issue_recovery_full_passes" ADD CONSTRAINT "issue_recovery_full_passes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;