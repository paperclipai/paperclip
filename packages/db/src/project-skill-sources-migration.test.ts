import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("project skill source migration replay", () => {
  it("keeps imported content, private provenance and scheduling when renumbered SQL runs again", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-project-skill-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID();
      const sourceId = randomUUID(), skillId = randomUUID(), bindingId = randomUUID(), agentId = randomUUID();
      const connectionId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Migration company', 'PSM')`;
      await sql`INSERT INTO projects (id, company_id, name, visibility) VALUES (${projectId}, ${companyId}, 'Private project', 'private')`;
      await sql`INSERT INTO project_workspaces (id, company_id, project_id, name, repo_url) VALUES (${workspaceId}, ${companyId}, ${projectId}, 'Repository', 'https://github.com/acme/skills')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Setup agent')`;
      await sql`INSERT INTO company_skill_sources (id, company_id, repository_url, full_name, tracking_ref, access_scope, automatic_updates, import_new_skills, refresh_user_id, refresh_agent_id, connection_id, excluded_folders, revision, failure_count, next_sync_at)
        VALUES (${sourceId}, ${companyId}, 'https://github.com/acme/skills', 'acme/skills', 'HEAD', 'projects', false, true, 'setup-person', ${agentId}, ${connectionId}, '["excluded"]', 7, 3, '2030-01-01')`;
      await sql`INSERT INTO company_skills (id, company_id, key, slug, name, markdown, access_source_id) VALUES (${skillId}, ${companyId}, 'repo/review', 'review', 'Review', 'Keep installed content', ${sourceId})`;
      await sql`INSERT INTO project_skill_sources (id, company_id, project_id, workspace_id, source_id, repository_url, tracking_ref, active, status, refresh_user_id, refresh_agent_id, connection_id)
        VALUES (${bindingId}, ${companyId}, ${projectId}, ${workspaceId}, ${sourceId}, 'https://github.com/acme/skills', 'HEAD', false, 'ready', 'setup-person', ${agentId}, ${connectionId})`;
      // Preview builds used an agent FK that would erase the authorizing identity.
      await sql.unsafe('ALTER TABLE project_skill_sources ADD CONSTRAINT project_skill_sources_refresh_agent_id_agents_id_fk FOREIGN KEY (refresh_agent_id) REFERENCES agents(id) ON DELETE SET NULL');
      const source = () => sql`SELECT * FROM company_skill_sources WHERE id = ${sourceId}`;
      const binding = () => sql`SELECT * FROM project_skill_sources WHERE id = ${bindingId}`;
      const skill = () => sql`SELECT * FROM company_skills WHERE id = ${skillId}`;
      const relations = () => sql`SELECT oid::text, relname FROM pg_class WHERE relname IN ('company_skill_sources', 'project_skill_sources', 'company_skills') ORDER BY relname`;
      const before = { source: await source(), binding: await binding(), skill: await skill(), relations: await relations() };
      const migration = await readFile(new URL("./migrations/0341_abnormal_bucky.sql", import.meta.url), "utf8");
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await sql.unsafe(statement);
        }
        expect(await source()).toEqual(before.source);
        expect(await binding()).toEqual(before.binding);
        expect(await skill()).toEqual(before.skill);
        expect(await relations()).toEqual(before.relations);
      }
      await sql`DELETE FROM agents WHERE id = ${agentId}`;
      expect((await source())[0]?.refresh_agent_id).toBe(agentId);
      expect((await binding())[0]?.refresh_agent_id).toBe(agentId);
      expect((await binding())[0]?.connection_id).toBe(connectionId);
      expect((await skill())[0]?.access_source_id).toBe(sourceId);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
