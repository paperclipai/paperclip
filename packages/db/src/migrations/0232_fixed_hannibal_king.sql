CREATE TABLE IF NOT EXISTS "connection_grant_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_grant_members_subject_type_check" CHECK ("connection_grant_members"."subject_type" in ('user'))
);
--> statement-breakpoint
ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_company_grant_fk";--> statement-breakpoint
ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_grant_id_connection_grants_id_fk";--> statement-breakpoint
ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_kind_check";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_subject_check";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_default_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_policy_check";--> statement-breakpoint
DROP INDEX IF EXISTS "connection_grants_default_uq";--> statement-breakpoint
UPDATE "connection_grants" SET "kind" = 'organization' WHERE "kind" = 'workspace';--> statement-breakpoint
INSERT INTO "connection_grants" (
	"company_id", "connection_id", "kind", "credential_secret_refs", "status", "is_default",
	"created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
	c."company_id", c."id", 'organization', c."credential_secret_refs", 'active', true,
	c."created_by_agent_id", c."created_by_user_id", c."created_at", c."updated_at"
FROM "tool_connections" c
WHERE NOT EXISTS (
	SELECT 1 FROM "connection_grants" g
	WHERE g."connection_id" = c."id" AND g."is_default" = true
);--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "credential_policy" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'connection_grants_company_id_uq'
			AND conrelid = 'connection_grants'::regclass
	) THEN
		ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_id_uq" UNIQUE("company_id","id");
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_grant_members_company_subject_idx" ON "connection_grant_members" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grant_members_grant_subject_uq" ON "connection_grant_members" USING btree ("grant_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grants_default_uq" ON "connection_grants" USING btree ("connection_id") WHERE "connection_grants"."is_default" = true and "connection_grants"."kind" = 'organization';--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user'));--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null));--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_default_check" CHECK ("connection_grants"."is_default" = false or "connection_grants"."kind" = 'organization');--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback'));
--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "addressee_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_user_idx" ON "issue_thread_interactions" USING btree ("addressee_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connection_grant_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_grant_fk";
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_grant_delegations_company_agent_idx" ON "connection_grant_delegations" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grant_delegations_grant_agent_uq" ON "connection_grant_delegations" USING btree ("grant_id","agent_id");
--> statement-breakpoint
-- A legacy company-scoped credential can only become user-scoped when exactly
-- one personal owner references it and no organization grant, connection, or
-- company binding also references it. Ambiguous rows fail closed in-place:
-- remove only personal-grant references and require those users to
-- reauthorize. Organization grants, shared/fallback connections, company
-- bindings, and routine triggers keep the original company-scoped secret so
-- their existing consumers continue to resolve it. Connection rows also keep
-- direct references: policy-aware resolution ignores them for strict per-user
-- access, while stripping them would break an independent shared consumer.
DROP TABLE IF EXISTS "phase4_ambiguous_personal_secrets";
--> statement-breakpoint
CREATE TEMP TABLE "phase4_ambiguous_personal_secrets" ON COMMIT DROP AS
WITH personal_secret_owners AS (
	SELECT
		s."id" AS "secret_id",
		s."company_id",
		count(DISTINCT g."subject_user_id") AS "owner_count"
	FROM "company_secrets" s
	JOIN "connection_grants" g
		ON g."company_id" = s."company_id"
		AND g."kind" = 'user'
	CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") personal_ref
	WHERE s."scope" = 'company'
		AND s."id"::text = personal_ref ->> 'secretId'
	GROUP BY s."id", s."company_id"
)
	SELECT owners."secret_id", owners."company_id"
	FROM personal_secret_owners owners
	WHERE owners."owner_count" <> 1
		OR EXISTS (
			SELECT 1
			FROM "connection_grants" organization_grant
			CROSS JOIN LATERAL jsonb_array_elements(organization_grant."credential_secret_refs") organization_ref
			WHERE organization_grant."company_id" = owners."company_id"
				AND organization_grant."kind" <> 'user'
				AND organization_ref ->> 'secretId' = owners."secret_id"::text
		)
			OR EXISTS (
				SELECT 1
				FROM "tool_connections" connection
			CROSS JOIN LATERAL jsonb_array_elements(connection."credential_secret_refs") connection_ref
			WHERE connection."company_id" = owners."company_id"
					AND connection_ref ->> 'secretId' = owners."secret_id"::text
			)
			OR EXISTS (
				SELECT 1
				FROM "company_secret_bindings" binding
				WHERE binding."company_id" = owners."company_id"
					AND binding."secret_id" = owners."secret_id"
			)
			OR EXISTS (
				SELECT 1
				FROM "routine_triggers" routine_trigger
				WHERE routine_trigger."company_id" = owners."company_id"
					AND routine_trigger."secret_id" = owners."secret_id"
			);
--> statement-breakpoint
WITH ambiguous_secrets AS (
	SELECT "secret_id", "company_id" FROM "phase4_ambiguous_personal_secrets"
)
UPDATE "connection_grants" grant_row
SET
	"credential_secret_refs" = COALESCE((
		SELECT jsonb_agg(ref)
		FROM jsonb_array_elements(grant_row."credential_secret_refs") ref
		WHERE NOT EXISTS (
			SELECT 1
			FROM ambiguous_secrets ambiguous
			WHERE ambiguous."company_id" = grant_row."company_id"
				AND ref ->> 'secretId' = ambiguous."secret_id"::text
		)
	), '[]'::jsonb),
	"status" = 'needs_reauthorization',
	"is_default" = false,
	"updated_at" = now()
WHERE grant_row."kind" = 'user'
	AND EXISTS (
	SELECT 1
	FROM jsonb_array_elements(grant_row."credential_secret_refs") ref
	JOIN ambiguous_secrets ambiguous
		ON ambiguous."company_id" = grant_row."company_id"
		AND ref ->> 'secretId' = ambiguous."secret_id"::text
);
--> statement-breakpoint
DROP TABLE IF EXISTS "phase4_ambiguous_personal_secrets";
--> statement-breakpoint
INSERT INTO "user_secret_definitions" (
	"company_id", "key", "name", "description", "provider", "managed_mode",
	"provider_config_id", "provider_metadata", "created_by_agent_id", "created_by_user_id"
)
SELECT DISTINCT
	s."company_id",
	'tool_oauth.' || s."id"::text,
	s."name",
	'Personal connection credential migrated to user scope.',
	s."provider",
	s."managed_mode",
	s."provider_config_id",
	s."provider_metadata",
	s."created_by_agent_id",
	s."created_by_user_id"
FROM "company_secrets" s
JOIN "connection_grants" g ON g."company_id" = s."company_id" AND g."kind" = 'user'
CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") ref
WHERE s."id"::text = ref ->> 'secretId'
	AND s."scope" = 'company'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "company_secrets" s
SET
	"scope" = 'user',
	"owner_user_id" = owner_map."owner_user_id",
	"user_secret_definition_id" = d."id",
	"updated_at" = now()
FROM (
	SELECT s2."id" AS "secret_id", min(g."subject_user_id") AS "owner_user_id"
	FROM "company_secrets" s2
	JOIN "connection_grants" g ON g."company_id" = s2."company_id" AND g."kind" = 'user'
	CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") ref
	WHERE s2."id"::text = ref ->> 'secretId' AND s2."scope" = 'company'
	GROUP BY s2."id"
	HAVING count(DISTINCT g."subject_user_id") = 1
) owner_map
JOIN "user_secret_definitions" d ON d."key" = 'tool_oauth.' || owner_map."secret_id"::text AND d."deleted_at" IS NULL
WHERE s."id" = owner_map."secret_id" AND d."company_id" = s."company_id";
