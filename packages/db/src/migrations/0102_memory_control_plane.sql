CREATE TABLE "memory_binding_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text DEFAULT 'default' NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid,
	"operation" text NOT NULL,
	"hook_kind" text,
	"intent" text,
	"status" text NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"scope_json" jsonb,
	"request_json" jsonb,
	"result_json" jsonb,
	"usage_json" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_binding_targets_company_target_uq" ON "memory_binding_targets" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_bindings_company_key_uq" ON "memory_bindings" USING btree ("company_id","key");--> statement-breakpoint
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_id_company_uq" UNIQUE("id","company_id");--> statement-breakpoint
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_binding_company_fk" FOREIGN KEY ("binding_id","company_id") REFERENCES "public"."memory_bindings"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_operations_company_created_idx" ON "memory_operations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_operations_company_run_idx" ON "memory_operations" USING btree ("company_id","heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "memory_operations_company_agent_created_idx" ON "memory_operations" USING btree ("company_id","agent_id","created_at");
