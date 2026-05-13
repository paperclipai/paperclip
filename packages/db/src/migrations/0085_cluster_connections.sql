CREATE TABLE IF NOT EXISTS "cluster_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"kubeconfig_secret_ref" jsonb,
	"api_server_url" text,
	"default_namespace_prefix" text DEFAULT 'paperclip-' NOT NULL,
	"capabilities" jsonb NOT NULL,
	"paperclip_public_url" text,
	"image_registry" text,
	"allow_agent_image_override" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cluster_namespace_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_connection_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"namespace_name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cluster_tenant_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_connection_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"quota_json" jsonb,
	"limit_range_json" jsonb,
	"network_json" jsonb,
	"image_overrides_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cluster_namespace_bindings_cluster_connection_id_cluster_connections_id_fk') THEN
		ALTER TABLE "cluster_namespace_bindings" ADD CONSTRAINT "cluster_namespace_bindings_cluster_connection_id_cluster_connections_id_fk" FOREIGN KEY ("cluster_connection_id") REFERENCES "public"."cluster_connections"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cluster_namespace_bindings_company_id_companies_id_fk') THEN
		ALTER TABLE "cluster_namespace_bindings" ADD CONSTRAINT "cluster_namespace_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cluster_tenant_policies_cluster_connection_id_cluster_connections_id_fk') THEN
		ALTER TABLE "cluster_tenant_policies" ADD CONSTRAINT "cluster_tenant_policies_cluster_connection_id_cluster_connections_id_fk" FOREIGN KEY ("cluster_connection_id") REFERENCES "public"."cluster_connections"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cluster_tenant_policies_company_id_companies_id_fk') THEN
		ALTER TABLE "cluster_tenant_policies" ADD CONSTRAINT "cluster_tenant_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_connections_label_uq" ON "cluster_connections" USING btree ("label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_connections_kind_idx" ON "cluster_connections" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_namespace_bindings_cluster_company_uq" ON "cluster_namespace_bindings" USING btree ("cluster_connection_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_namespace_bindings_cluster_ns_uq" ON "cluster_namespace_bindings" USING btree ("cluster_connection_id","namespace_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_namespace_bindings_company_idx" ON "cluster_namespace_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_tenant_policies_cluster_company_uq" ON "cluster_tenant_policies" USING btree ("cluster_connection_id","company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_tenant_policies_company_idx" ON "cluster_tenant_policies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);
