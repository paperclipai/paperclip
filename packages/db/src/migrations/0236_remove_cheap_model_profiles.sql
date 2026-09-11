CREATE INDEX IF NOT EXISTS "agents_remove_model_profiles_idx"
	ON "agents" USING btree ("id")
	WHERE "runtime_config" ? 'modelProfiles';--> statement-breakpoint

DO $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS MATERIALIZED (
			SELECT "id"
			FROM "agents"
			WHERE "runtime_config" ? 'modelProfiles'
			ORDER BY "id"
			LIMIT 1000
		)
		UPDATE "agents" AS agent
		SET "runtime_config" = agent."runtime_config" - 'modelProfiles',
			"updated_at" = now()
		FROM batch
		WHERE agent."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "agents_remove_model_profiles_idx";--> statement-breakpoint

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This temporary partial index covers only revision snapshots with the retired JSON key and is dropped after the bounded cleanup.
CREATE INDEX IF NOT EXISTS "agent_config_revisions_remove_model_profiles_idx"
	ON "agent_config_revisions" USING btree ("id")
	WHERE ("before_config" #> '{runtimeConfig}') ? 'modelProfiles'
		OR ("after_config" #> '{runtimeConfig}') ? 'modelProfiles';--> statement-breakpoint

DO $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS MATERIALIZED (
			SELECT "id"
			FROM "agent_config_revisions"
			WHERE ("before_config" #> '{runtimeConfig}') ? 'modelProfiles'
				OR ("after_config" #> '{runtimeConfig}') ? 'modelProfiles'
			ORDER BY "id"
			LIMIT 1000
		)
		UPDATE "agent_config_revisions" AS revision
		SET "before_config" = CASE
				WHEN (revision."before_config" #> '{runtimeConfig}') ? 'modelProfiles'
				THEN jsonb_set(
					revision."before_config",
					'{runtimeConfig}',
					(revision."before_config" #> '{runtimeConfig}') - 'modelProfiles'
				)
				ELSE revision."before_config"
			END,
			"after_config" = CASE
				WHEN (revision."after_config" #> '{runtimeConfig}') ? 'modelProfiles'
				THEN jsonb_set(
					revision."after_config",
					'{runtimeConfig}',
					(revision."after_config" #> '{runtimeConfig}') - 'modelProfiles'
				)
				ELSE revision."after_config"
			END
		FROM batch
		WHERE revision."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "agent_config_revisions_remove_model_profiles_idx";--> statement-breakpoint

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This temporary partial index covers only rows with the retired JSON key and is dropped after the bounded cleanup.
CREATE INDEX IF NOT EXISTS "issues_remove_model_profile_idx"
	ON "issues" USING btree ("id")
	WHERE "assignee_adapter_overrides" ? 'modelProfile';--> statement-breakpoint

DO $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS MATERIALIZED (
			SELECT "id"
			FROM "issues"
			WHERE "assignee_adapter_overrides" ? 'modelProfile'
			ORDER BY "id"
			LIMIT 1000
		)
		UPDATE "issues" AS issue
		SET "assignee_adapter_overrides" = NULLIF(
			issue."assignee_adapter_overrides" - 'modelProfile',
			'{}'::jsonb
		)
		FROM batch
		WHERE issue."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "issues_remove_model_profile_idx";
