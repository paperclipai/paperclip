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
		),
			"updated_at" = now()
		FROM batch
		WHERE issue."id" = batch."id";

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "issues_remove_model_profile_idx";
