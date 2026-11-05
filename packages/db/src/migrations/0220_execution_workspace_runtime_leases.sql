CREATE TABLE "execution_workspace_runtime_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"owner_key" text NOT NULL,
	"owner_issue_id" uuid,
	"owner_run_id" uuid,
	"owner_agent_id" uuid,
	"last_action" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_workspace_runtime_leases_execution_workspace_id_unique" UNIQUE("execution_workspace_id")
);
--> statement-breakpoint
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_owner_issue_id_issues_id_fk" FOREIGN KEY ("owner_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_owner_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_runtime_leases" ADD CONSTRAINT "execution_workspace_runtime_leases_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_workspace_runtime_leases_company_workspace_idx" ON "execution_workspace_runtime_leases" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "execution_workspace_runtime_leases_company_owner_idx" ON "execution_workspace_runtime_leases" USING btree ("company_id","owner_key");--> statement-breakpoint
CREATE INDEX "execution_workspace_runtime_leases_expires_at_idx" ON "execution_workspace_runtime_leases" USING btree ("expires_at");
