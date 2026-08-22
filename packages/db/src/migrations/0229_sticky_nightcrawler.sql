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
-- one personal owner references it and no organization grant or connection
-- also references it. Ambiguous rows fail closed in-place: remove every live
-- reference, require reauthorization, and disable affected connections. This
-- keeps the instance bootable while ensuring the credential is never assigned
-- to an arbitrary user.
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
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements(grant_row."credential_secret_refs") ref
	JOIN ambiguous_secrets ambiguous
		ON ambiguous."company_id" = grant_row."company_id"
		AND ref ->> 'secretId' = ambiguous."secret_id"::text
);
--> statement-breakpoint
WITH ambiguous_secrets AS (
	SELECT "secret_id", "company_id" FROM "phase4_ambiguous_personal_secrets"
)
UPDATE "tool_connections" connection_row
SET
	"credential_secret_refs" = COALESCE((
		SELECT jsonb_agg(ref)
		FROM jsonb_array_elements(connection_row."credential_secret_refs") ref
		WHERE NOT EXISTS (
			SELECT 1
			FROM ambiguous_secrets ambiguous
			WHERE ambiguous."company_id" = connection_row."company_id"
				AND ref ->> 'secretId' = ambiguous."secret_id"::text
		)
	), '[]'::jsonb),
	"status" = 'draft',
	"enabled" = false,
	"health_status" = 'missing_secret',
	"health_message" = 'Legacy personal credential ownership was ambiguous. Reauthorize this connection.',
	"last_error" = 'oauth_reauthorization_required',
	"updated_at" = now()
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements(connection_row."credential_secret_refs") ref
	JOIN ambiguous_secrets ambiguous
		ON ambiguous."company_id" = connection_row."company_id"
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
