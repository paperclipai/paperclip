CREATE TABLE "rt2_v33_graph_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"source_id" text NOT NULL,
	"label" text NOT NULL,
	"report_date" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_graph_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"confidence" text NOT NULL,
	"confidence_score" numeric(4, 2),
	"rationale" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_graph_cache" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"input_window" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_projected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_graph_communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"community_key" text NOT NULL,
	"algorithm" text NOT NULL,
	"label" text NOT NULL,
	"member_node_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_graph_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"confidence_summary" jsonb DEFAULT '{"EXTRACTED":0,"INFERRED":0,"AMBIGUOUS":0}'::jsonb NOT NULL,
	"central_task_node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ambiguous_edges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_nodes" ADD CONSTRAINT "rt2_v33_graph_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_nodes" ADD CONSTRAINT "rt2_v33_graph_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_edges" ADD CONSTRAINT "rt2_v33_graph_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_edges" ADD CONSTRAINT "rt2_v33_graph_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_edges" ADD CONSTRAINT "rt2_v33_graph_edges_source_node_id_rt2_v33_graph_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."rt2_v33_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_edges" ADD CONSTRAINT "rt2_v33_graph_edges_target_node_id_rt2_v33_graph_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."rt2_v33_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_cache" ADD CONSTRAINT "rt2_v33_graph_cache_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_cache" ADD CONSTRAINT "rt2_v33_graph_cache_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_communities" ADD CONSTRAINT "rt2_v33_graph_communities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_communities" ADD CONSTRAINT "rt2_v33_graph_communities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_reports" ADD CONSTRAINT "rt2_v33_graph_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_reports" ADD CONSTRAINT "rt2_v33_graph_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rt2_v33_graph_nodes_company_project_type_idx" ON "rt2_v33_graph_nodes" USING btree ("company_id","project_id","node_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_graph_nodes_company_node_key_uq" ON "rt2_v33_graph_nodes" USING btree ("company_id","node_key");
--> statement-breakpoint
CREATE INDEX "rt2_v33_graph_edges_company_project_source_idx" ON "rt2_v33_graph_edges" USING btree ("company_id","project_id","source_node_id");
--> statement-breakpoint
CREATE INDEX "rt2_v33_graph_edges_company_project_target_idx" ON "rt2_v33_graph_edges" USING btree ("company_id","project_id","target_node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_graph_edges_company_edge_uq" ON "rt2_v33_graph_edges" USING btree ("company_id","project_id","source_node_id","target_node_id","edge_type");
--> statement-breakpoint
CREATE INDEX "rt2_v33_graph_communities_company_project_idx" ON "rt2_v33_graph_communities" USING btree ("company_id","project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_graph_communities_company_community_uq" ON "rt2_v33_graph_communities" USING btree ("company_id","project_id","community_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_graph_reports_company_project_uq" ON "rt2_v33_graph_reports" USING btree ("company_id","project_id");
