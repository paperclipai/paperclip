CREATE TABLE IF NOT EXISTS "rt2_v33_semantic_index_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_key" text NOT NULL,
  "chunk_key" text NOT NULL,
  "chunk_text" text NOT NULL,
  "content_hash" text NOT NULL,
  "embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "embedding_model" text NOT NULL,
  "embedding_provider" text NOT NULL,
  "embedding_dimension" integer NOT NULL,
  "source_updated_at" timestamp with time zone NOT NULL,
  "freshness" text DEFAULT 'fresh' NOT NULL,
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_semantic_chunks_company_source_chunk_uq"
  ON "rt2_v33_semantic_index_chunks" ("company_id", "source_type", "source_id", "chunk_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_semantic_chunks_company_project_source_idx"
  ON "rt2_v33_semantic_index_chunks" ("company_id", "project_id", "source_type");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_semantic_chunks_company_freshness_idx"
  ON "rt2_v33_semantic_index_chunks" ("company_id", "freshness");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_semantic_chunks_company_content_hash_idx"
  ON "rt2_v33_semantic_index_chunks" ("company_id", "content_hash");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rt2_v33_semantic_index_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "mode" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "provider_mode" text NOT NULL,
  "embedding_model" text NOT NULL,
  "sources_scanned" integer DEFAULT 0 NOT NULL,
  "chunks_refreshed" integer DEFAULT 0 NOT NULL,
  "chunks_skipped" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_semantic_runs_company_started_idx"
  ON "rt2_v33_semantic_index_runs" ("company_id", "started_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_semantic_runs_company_status_idx"
  ON "rt2_v33_semantic_index_runs" ("company_id", "status");
