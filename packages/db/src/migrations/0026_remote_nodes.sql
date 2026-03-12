CREATE TABLE "nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'offline' NOT NULL,
  "capabilities" jsonb DEFAULT '{}' NOT NULL,
  "last_seen_at" timestamp with time zone,
  "registered_by_actor_type" text,
  "registered_by_actor_id" text,
  "metadata" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "nodes" ADD CONSTRAINT "nodes_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "nodes_company_status_idx" ON "nodes" USING btree ("company_id","status");
CREATE UNIQUE INDEX "nodes_company_name_unique_idx" ON "nodes" USING btree ("company_id","name");

CREATE TABLE "node_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "node_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "key_hash" text NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "node_api_keys" ADD CONSTRAINT "node_api_keys_node_id_nodes_id_fk"
  FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "node_api_keys" ADD CONSTRAINT "node_api_keys_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "node_api_keys_key_hash_idx" ON "node_api_keys" USING btree ("key_hash");
CREATE INDEX "node_api_keys_company_node_idx" ON "node_api_keys" USING btree ("company_id","node_id");

ALTER TABLE "heartbeat_runs" ADD COLUMN "remote_claimed_at" timestamp with time zone;
