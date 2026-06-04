CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"driver" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_policy" text DEFAULT 'ephemeral' NOT NULL,
	"provider" text,
	"provider_lease_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"failure_reason" text,
	"cleanup_status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environments_company_status_idx" ON "environments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver");--> statement-breakpoint
CREATE INDEX "environments_company_name_idx" ON "environments" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "environment_leases_company_environment_status_idx" ON "environment_leases" USING btree ("company_id","environment_id","status");--> statement-breakpoint
CREATE INDEX "environment_leases_company_execution_workspace_idx" ON "environment_leases" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "environment_leases_company_issue_idx" ON "environment_leases" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "environment_leases_heartbeat_run_idx" ON "environment_leases" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "environment_leases_company_last_used_idx" ON "environment_leases" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "environment_leases_provider_lease_idx" ON "environment_leases" USING btree ("provider_lease_id");
