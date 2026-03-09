CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_key" text NOT NULL,
	"package_name" text NOT NULL,
	"version" text NOT NULL,
	"api_version" integer DEFAULT 1 NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"status" text DEFAULT 'installed' NOT NULL,
	"install_order" integer,
	"last_error" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"namespace" text DEFAULT 'default' NOT NULL,
	"state_key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_state_unique_entry_idx" UNIQUE NULLS NOT DISTINCT("plugin_id","scope_kind","scope_id","namespace","state_key")
);
--> statement-breakpoint
CREATE TABLE "plugin_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"external_id" text,
	"title" text,
	"status" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"job_key" text NOT NULL,
	"schedule" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"webhook_key" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_state" ADD CONSTRAINT "plugin_state_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_jobs" ADD CONSTRAINT "plugin_jobs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_job_id_plugin_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."plugin_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("plugin_key");--> statement-breakpoint
CREATE INDEX "plugins_status_idx" ON "plugins" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_config_plugin_id_idx" ON "plugin_config" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_state_plugin_scope_idx" ON "plugin_state" USING btree ("plugin_id","scope_kind");--> statement-breakpoint
CREATE INDEX "plugin_entities_plugin_idx" ON "plugin_entities" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_entities_type_idx" ON "plugin_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "plugin_entities_scope_idx" ON "plugin_entities" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_entities_external_idx" ON "plugin_entities" USING btree ("plugin_id","entity_type","external_id");--> statement-breakpoint
CREATE INDEX "plugin_jobs_plugin_idx" ON "plugin_jobs" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_jobs_next_run_idx" ON "plugin_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_jobs_unique_idx" ON "plugin_jobs" USING btree ("plugin_id","job_key");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_job_idx" ON "plugin_job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_plugin_idx" ON "plugin_job_runs" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_status_idx" ON "plugin_job_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_plugin_idx" ON "plugin_webhook_deliveries" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_status_idx" ON "plugin_webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_key_idx" ON "plugin_webhook_deliveries" USING btree ("webhook_key");
