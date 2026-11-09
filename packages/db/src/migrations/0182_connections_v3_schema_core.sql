ALTER TABLE "tool_connections" ADD COLUMN "uid" text;
ALTER TABLE "tool_connections" ADD COLUMN "ownership" text DEFAULT 'customer' NOT NULL;
ALTER TABLE "tool_connections" ADD COLUMN "auth_kind" text DEFAULT 'none' NOT NULL;

UPDATE "tool_connections" AS c
SET "uid" = concat(
  coalesce(nullif(regexp_replace(lower(a."application_key"), '[^a-z0-9]+', '-', 'g'), ''), 'app'),
  '/',
  coalesce(nullif(trim(both '-' from regexp_replace(lower(c."name"), '[^a-z0-9]+', '-', 'g')), ''), 'connection'),
  '-',
  left(c."id"::text, 8)
)
FROM "tool_applications" AS a
WHERE a."id" = c."application_id";

UPDATE "tool_connections"
SET "transport" = 'mcp_remote'
WHERE "transport" = 'remote_http';

UPDATE "tool_connections"
SET "auth_kind" = CASE
  WHEN jsonb_typeof("config" -> 'oauth') = 'object' THEN 'oauth'
  WHEN jsonb_array_length(coalesce("credential_secret_refs", '[]'::jsonb)) > 0
    OR jsonb_array_length(coalesce("credential_refs", '[]'::jsonb)) > 0 THEN 'api_key'
  ELSE 'none'
END;

ALTER TABLE "tool_connections" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "tool_connections_company_uid_uq" ON "tool_connections" USING btree ("company_id", "uid");
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_company_id_uq" UNIQUE ("company_id", "id");
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_ownership_check" CHECK ("ownership" in ('platform_shared', 'platform_provisioned', 'customer', 'dcr'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("transport" in ('mcp_remote', 'rest_api', 'local_stdio'));
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_auth_kind_check" CHECK ("auth_kind" in ('oauth', 'api_key', 'none'));

CREATE TABLE "connection_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "subject_user_id" text,
  "provider_tenant" jsonb,
  "credential_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "revoked_at" timestamp with time zone,
  "revoked_by_agent_id" uuid,
  "revoked_by_user_id" text,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connection_grants_kind_check" CHECK ("kind" in ('workspace', 'user')),
  CONSTRAINT "connection_grants_status_check" CHECK ("status" in ('active', 'revoked', 'expired', 'needs_reauthorization')),
  CONSTRAINT "connection_grants_subject_check" CHECK (("kind" = 'user' and "subject_user_id" is not null) or ("kind" = 'workspace' and "subject_user_id" is null)),
  CONSTRAINT "connection_grants_default_check" CHECK ("is_default" = false or "kind" = 'workspace')
);
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_connection_fk" FOREIGN KEY ("company_id", "connection_id") REFERENCES "public"."tool_connections"("company_id", "id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_revoked_by_agent_id_agents_id_fk" FOREIGN KEY ("revoked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "connection_grants_company_connection_idx" ON "connection_grants" USING btree ("company_id", "connection_id");
CREATE INDEX "connection_grants_subject_user_idx" ON "connection_grants" USING btree ("company_id", "subject_user_id");
CREATE UNIQUE INDEX "connection_grants_user_uq" ON "connection_grants" USING btree ("connection_id", "subject_user_id");
CREATE UNIQUE INDEX "connection_grants_default_uq" ON "connection_grants" USING btree ("connection_id") WHERE "is_default" = true AND "kind" = 'workspace';

INSERT INTO "connection_grants" (
  "company_id", "connection_id", "kind", "credential_secret_refs", "status", "is_default",
  "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
  "company_id", "id", 'workspace', "credential_secret_refs", 'active', true,
  "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
FROM "tool_connections";
