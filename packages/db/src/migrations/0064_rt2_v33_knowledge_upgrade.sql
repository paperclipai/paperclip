ALTER TABLE "rt2_v33_graph_nodes" ADD COLUMN "centrality" numeric(8, 6) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_nodes" ADD COLUMN "is_god_node" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_communities" ADD COLUMN "god_node_id" uuid;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_communities" ADD COLUMN "report_path" text;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_communities" ADD CONSTRAINT "rt2_v33_graph_communities_god_node_id_rt2_v33_graph_nodes_id_fk" FOREIGN KEY ("god_node_id") REFERENCES "public"."rt2_v33_graph_nodes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_reports" ADD COLUMN "community_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_reports" ADD COLUMN "god_node_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rt2_v33_graph_reports" ADD COLUMN "surprising_connection_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "rt2_v33_surprising_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"node_a_id" uuid NOT NULL,
	"node_b_id" uuid NOT NULL,
	"cross_domain_score" numeric(6, 3) DEFAULT '0' NOT NULL,
	"plain_explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_surprising_connections" ADD CONSTRAINT "rt2_v33_surprising_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_surprising_connections" ADD CONSTRAINT "rt2_v33_surprising_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_surprising_connections" ADD CONSTRAINT "rt2_v33_surprising_connections_node_a_id_rt2_v33_graph_nodes_id_fk" FOREIGN KEY ("node_a_id") REFERENCES "public"."rt2_v33_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_surprising_connections" ADD CONSTRAINT "rt2_v33_surprising_connections_node_b_id_rt2_v33_graph_nodes_id_fk" FOREIGN KEY ("node_b_id") REFERENCES "public"."rt2_v33_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rt2_v33_surprising_connections_company_project_idx" ON "rt2_v33_surprising_connections" USING btree ("company_id","project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_surprising_connections_company_pair_uq" ON "rt2_v33_surprising_connections" USING btree ("company_id","project_id","node_a_id","node_b_id");
