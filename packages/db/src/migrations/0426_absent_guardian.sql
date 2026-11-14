CREATE TABLE "execution_admission_project_charges" (
	"admission_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "execution_admission_project_charges_admission_id_project_id_pk" PRIMARY KEY("admission_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "execution_admissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"primary_project_id" uuid,
	"context_revision" text NOT NULL,
	"settlement_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_admissions_attempt_check" CHECK ("execution_admissions"."attempt" > 0),
	CONSTRAINT "execution_admissions_settlement_check" CHECK (("execution_admissions"."settlement_id" is null) = ("execution_admissions"."settled_at" is null))
);
--> statement-breakpoint
CREATE TABLE "project_task_execution_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"max_concurrent_tasks" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_execution_policies_maximum_check" CHECK ("project_task_execution_policies"."max_concurrent_tasks" is null or "project_task_execution_policies"."max_concurrent_tasks" > 0)
);
--> statement-breakpoint
CREATE INDEX "execution_admission_project_charges_project_idx" ON "execution_admission_project_charges" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admissions_company_id_uq" ON "execution_admissions" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admissions_run_attempt_uq" ON "execution_admissions" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admissions_live_run_uq" ON "execution_admissions" USING btree ("run_id") WHERE "execution_admissions"."settled_at" is null;--> statement-breakpoint
ALTER TABLE "execution_admission_project_charges" ADD CONSTRAINT "execution_admission_project_charges_company_admission_fk" FOREIGN KEY ("company_id","admission_id") REFERENCES "public"."execution_admissions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_project_charges" ADD CONSTRAINT "execution_admission_project_charges_company_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admissions" ADD CONSTRAINT "execution_admissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admissions" ADD CONSTRAINT "execution_admissions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_execution_policies" ADD CONSTRAINT "project_task_execution_policies_company_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;