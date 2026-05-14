CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "brain";
--> statement-breakpoint
CREATE TABLE "brain"."access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" text NOT NULL,
	"tool" text NOT NULL,
	"query" text,
	"path" text,
	"returned_paths" text[],
	"latency_ms" integer,
	"ok" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain"."agent_acl" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"allowed_folders" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain"."chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading_path" text[],
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(1024),
	"embedded_at" timestamp with time zone,
	CONSTRAINT "brain_chunks_note_chunk_unique" UNIQUE("note_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "brain"."notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"folder" text NOT NULL,
	"title" text,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mtime" timestamp with time zone NOT NULL,
	"size_bytes" integer NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "notes_path_unique" UNIQUE("path")
);
--> statement-breakpoint
ALTER TABLE "brain"."chunks" ADD CONSTRAINT "chunks_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "brain"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_access_log_ts_idx" ON "brain"."access_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "brain_access_log_agent_ts_idx" ON "brain"."access_log" USING btree ("agent_id","ts");--> statement-breakpoint
CREATE INDEX "brain_chunks_note_idx" ON "brain"."chunks" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "brain_chunks_embedding_idx" ON "brain"."chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "brain_notes_folder_idx" ON "brain"."notes" USING btree ("folder");--> statement-breakpoint
CREATE INDEX "brain_notes_frontmatter_idx" ON "brain"."notes" USING gin ("frontmatter");