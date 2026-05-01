CREATE TABLE IF NOT EXISTS "rt2_v33_corpus_graph_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_key" text NOT NULL,
  "source_type" text NOT NULL,
  "source_location" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sha256" text NOT NULL,
  "title" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_sources_company_type_idx"
  ON "rt2_v33_corpus_graph_sources" ("company_id", "source_type");

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_sources_company_source_key_uq"
  ON "rt2_v33_corpus_graph_sources" ("company_id", "source_key");

CREATE TABLE IF NOT EXISTS "rt2_v33_corpus_graph_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "node_key" text NOT NULL,
  "node_type" text NOT NULL,
  "label" text NOT NULL,
  "source_id" uuid REFERENCES "rt2_v33_corpus_graph_sources"("id") ON DELETE SET NULL,
  "source_location" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "centrality" numeric(8, 6) DEFAULT '0' NOT NULL,
  "community_key" text,
  "is_god_node" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_nodes_company_type_idx"
  ON "rt2_v33_corpus_graph_nodes" ("company_id", "node_type");

CREATE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_nodes_company_community_idx"
  ON "rt2_v33_corpus_graph_nodes" ("company_id", "community_key");

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_nodes_company_node_key_uq"
  ON "rt2_v33_corpus_graph_nodes" ("company_id", "node_key");

CREATE TABLE IF NOT EXISTS "rt2_v33_corpus_graph_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_node_id" uuid NOT NULL REFERENCES "rt2_v33_corpus_graph_nodes"("id") ON DELETE CASCADE,
  "target_node_id" uuid NOT NULL REFERENCES "rt2_v33_corpus_graph_nodes"("id") ON DELETE CASCADE,
  "edge_type" text NOT NULL,
  "relation" text NOT NULL,
  "confidence" text NOT NULL,
  "confidence_score" numeric(4, 2),
  "rationale" text NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_edges_company_source_idx"
  ON "rt2_v33_corpus_graph_edges" ("company_id", "source_node_id");

CREATE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_edges_company_target_idx"
  ON "rt2_v33_corpus_graph_edges" ("company_id", "target_node_id");

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_edges_company_edge_uq"
  ON "rt2_v33_corpus_graph_edges" ("company_id", "source_node_id", "target_node_id", "edge_type", "relation");

CREATE TABLE IF NOT EXISTS "rt2_v33_corpus_graph_communities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "community_key" text NOT NULL,
  "algorithm" text NOT NULL,
  "label" text NOT NULL,
  "member_node_count" integer DEFAULT 0 NOT NULL,
  "god_node_id" uuid REFERENCES "rt2_v33_corpus_graph_nodes"("id") ON DELETE SET NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_communities_company_idx"
  ON "rt2_v33_corpus_graph_communities" ("company_id");

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_communities_company_community_uq"
  ON "rt2_v33_corpus_graph_communities" ("company_id", "community_key");

CREATE TABLE IF NOT EXISTS "rt2_v33_corpus_graph_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "corpus_node_count" integer DEFAULT 0 NOT NULL,
  "corpus_edge_count" integer DEFAULT 0 NOT NULL,
  "product_node_count" integer DEFAULT 0 NOT NULL,
  "product_edge_count" integer DEFAULT 0 NOT NULL,
  "confidence_summary" jsonb DEFAULT '{"EXTRACTED":0,"INFERRED":0,"AMBIGUOUS":0}'::jsonb NOT NULL,
  "community_count" integer DEFAULT 0 NOT NULL,
  "god_node_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "knowledge_gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "surprising_connections" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "suggested_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "markdown" text DEFAULT '' NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_corpus_graph_reports_company_uq"
  ON "rt2_v33_corpus_graph_reports" ("company_id");
