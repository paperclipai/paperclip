CREATE TABLE "agent_repository_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"granted_by_agent_id" uuid,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_repository_id" text,
	"identity_key" text NOT NULL,
	"host" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"clone_url" text NOT NULL,
	"web_url" text,
	"default_branch" text,
	"visibility" text DEFAULT 'unknown' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"unavailable_reason" text,
	"provider_metadata" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"host" text NOT NULL,
	"installation_id" text,
	"account_id" text,
	"account_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"sync_cursor" text,
	"sync_error" text,
	"last_synced_at" timestamp with time zone,
	"provider_metadata" jsonb,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_repository_grants" ADD CONSTRAINT "agent_repository_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repository_grants" ADD CONSTRAINT "agent_repository_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repository_grants" ADD CONSTRAINT "agent_repository_grants_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repository_grants" ADD CONSTRAINT "agent_repository_grants_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_connection_id_repository_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_repository_grants_company_agent_idx" ON "agent_repository_grants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_repository_grants_company_repository_idx" ON "agent_repository_grants" USING btree ("company_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_repository_grants_company_relationship_idx" ON "agent_repository_grants" USING btree ("company_id","agent_id","repository_id");--> statement-breakpoint
CREATE INDEX "project_repositories_company_project_idx" ON "project_repositories" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "project_repositories_company_repository_idx" ON "project_repositories" USING btree ("company_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_repositories_company_relationship_idx" ON "project_repositories" USING btree ("company_id","project_id","repository_id");--> statement-breakpoint
CREATE INDEX "repositories_company_state_idx" ON "repositories" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "repositories_company_connection_idx" ON "repositories" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_company_identity_idx" ON "repositories" USING btree ("company_id","identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_company_provider_repository_idx" ON "repositories" USING btree ("company_id","provider","host","provider_repository_id") WHERE "repositories"."provider_repository_id" is not null;--> statement-breakpoint
CREATE INDEX "repository_connections_company_idx" ON "repository_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "repository_connections_company_provider_host_idx" ON "repository_connections" USING btree ("company_id","provider","host");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connections_company_installation_idx" ON "repository_connections" USING btree ("company_id","provider","host","installation_id") WHERE "repository_connections"."installation_id" is not null;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_workspaces_company_repository_idx" ON "project_workspaces" USING btree ("company_id","repository_id");--> statement-breakpoint
CREATE INDEX "project_workspaces_repository_backfill_idx"
	ON "project_workspaces" USING btree ("company_id", "id")
	WHERE "repo_url" IS NOT NULL AND btrim("repo_url") <> '';--> statement-breakpoint
DO $$
DECLARE
	company_record record;
	workspace_record record;
	last_workspace_id uuid;
	batch_count integer;
	raw_url text;
	sanitized_url text;
	parsing_url text;
	repository_host text;
	repository_path text;
	repository_owner text;
	repository_name text;
	repository_identity_key text;
	repository_web_url text;
	resolved_repository_id uuid;
	credential_redacted boolean;
BEGIN
	FOR company_record IN
		SELECT DISTINCT "company_id"
		FROM "project_workspaces"
		WHERE "repo_url" IS NOT NULL AND btrim("repo_url") <> ''
		ORDER BY "company_id"
	LOOP
		last_workspace_id := '00000000-0000-0000-0000-000000000000'::uuid;
		LOOP
			batch_count := 0;
			FOR workspace_record IN
				SELECT "id", "project_id", "repo_url"
				FROM "project_workspaces"
				WHERE "company_id" = company_record."company_id"
					AND "id" > last_workspace_id
					AND "repo_url" IS NOT NULL
					AND btrim("repo_url") <> ''
				ORDER BY "id"
				LIMIT 500
			LOOP
				batch_count := batch_count + 1;
				last_workspace_id := workspace_record."id";
				raw_url := btrim(workspace_record."repo_url");
				credential_redacted := (
					raw_url ~* '^[a-z][a-z0-9+.-]*://[^/@]+@'
					AND raw_url !~* '^ssh://[^/:@]+@'
				)
					OR raw_url ~* '[?&](access[_-]?token|auth|credential|key|password|secret|token)=';

				-- Standard SSH/scp usernames are transport identity, not stored
				-- credentials, and must remain intact so existing checkouts keep using
				-- the same authentication mechanism. Password-bearing URL userinfo and
				-- query/fragment data are never copied into repository metadata.
				IF raw_url ~ '^[^/@:]+@[^/:]+:.+$' THEN
					sanitized_url := regexp_replace(raw_url, '[?#].*$', '');
					SELECT lower(matches[1]), matches[2]
					INTO repository_host, repository_path
					FROM regexp_matches(
						sanitized_url,
						'^[^/@:]+@([^/:]+):(.+)$'
					) AS parsed(matches);
				ELSE
					sanitized_url := raw_url;
					IF sanitized_url !~* '^ssh://[^/:@]+@' THEN
						sanitized_url := regexp_replace(
							sanitized_url,
							'^([a-z][a-z0-9+.-]*://)[^/@]+@',
							'\1',
							'i'
						);
					END IF;
					sanitized_url := regexp_replace(sanitized_url, '[?#].*$', '');
					parsing_url := regexp_replace(sanitized_url, '^(ssh://)[^/:@]+@', '\1', 'i');

					SELECT lower(matches[1]), matches[2]
					INTO repository_host, repository_path
					FROM regexp_matches(
						parsing_url,
						'^[a-z][a-z0-9+.-]*://([^/]+)/(.+)$',
						'i'
					) AS parsed(matches);
				END IF;
				sanitized_url := regexp_replace(sanitized_url, '/+$', '');

				repository_path := regexp_replace(coalesce(repository_path, ''), '^/+|/+$', '', 'g');
				repository_path := regexp_replace(repository_path, '\.git$', '', 'i');
				IF repository_host IS NULL OR repository_host = '' OR repository_path !~ '/' THEN
					CONTINUE;
				END IF;

				repository_name := regexp_replace(repository_path, '^.*/', '');
				repository_owner := regexp_replace(repository_path, '/[^/]+$', '');
				IF repository_name = '' OR repository_owner = '' THEN
					CONTINUE;
				END IF;

				repository_identity_key := 'manual:' || repository_host || '/' || lower(repository_owner || '/' || repository_name);
				repository_web_url := 'https://' || repository_host || '/' || repository_owner || '/' || repository_name;

				INSERT INTO "repositories" (
					"company_id",
					"provider",
					"identity_key",
					"host",
					"owner",
					"name",
					"clone_url",
					"web_url",
					"provider_metadata"
				) VALUES (
					company_record."company_id",
					'manual',
					repository_identity_key,
					repository_host,
					repository_owner,
					repository_name,
					sanitized_url,
					repository_web_url,
					jsonb_build_object(
						'legacyWorkspaceBackfill', true,
						'credentialRedacted', credential_redacted
					)
				)
				ON CONFLICT ("company_id", "identity_key") DO UPDATE
				SET "provider_metadata" = jsonb_build_object(
					'legacyWorkspaceBackfill', true,
					'credentialRedacted',
					coalesce(("repositories"."provider_metadata" ->> 'credentialRedacted')::boolean, false)
						OR credential_redacted
				);

				SELECT "id"
				INTO resolved_repository_id
				FROM "repositories"
				WHERE "company_id" = company_record."company_id"
					AND "identity_key" = repository_identity_key;

				INSERT INTO "project_repositories" (
					"company_id", "project_id", "repository_id"
				) VALUES (
					company_record."company_id", workspace_record."project_id", resolved_repository_id
				)
				ON CONFLICT ("company_id", "project_id", "repository_id") DO NOTHING;

				UPDATE "project_workspaces"
				SET "repository_id" = resolved_repository_id,
					"repo_url" = sanitized_url,
					"updated_at" = now()
				WHERE "company_id" = company_record."company_id"
					AND "id" = workspace_record."id";
			END LOOP;

			EXIT WHEN batch_count < 500;
		END LOOP;
	END LOOP;
END $$;--> statement-breakpoint
DROP INDEX "project_workspaces_repository_backfill_idx";
