CREATE TABLE "memory_binding_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"provider_key" text NOT NULL,
	"plugin_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"source_ref" jsonb,
	"usage" jsonb,
	"latency_ms" integer,
	"success" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_binding_targets_binding_idx" ON "memory_binding_targets" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "memory_binding_targets_target_idx" ON "memory_binding_targets" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_binding_targets_unique_idx" ON "memory_binding_targets" USING btree ("binding_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_bindings_company_key_idx" ON "memory_bindings" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "memory_bindings_company_idx" ON "memory_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_operations_company_binding_idx" ON "memory_operations" USING btree ("company_id","binding_id");--> statement-breakpoint
CREATE INDEX "memory_operations_company_agent_date_idx" ON "memory_operations" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_operations_company_date_idx" ON "memory_operations" USING btree ("company_id","created_at");