CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"number" integer,
	"starts_at" date,
	"ends_at" date,
	"origin_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_cycles" (
	"issue_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_cycles_pk" PRIMARY KEY("issue_id","cycle_id")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "estimate" integer;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycles_company_idx" ON "cycles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_origin_idx" ON "cycles" USING btree ("company_id","origin_id");--> statement-breakpoint
CREATE INDEX "issue_cycles_issue_idx" ON "issue_cycles" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_cycles_cycle_idx" ON "issue_cycles" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "issue_cycles_company_idx" ON "issue_cycles" USING btree ("company_id");