import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0213_lowly_chameleon.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("first-class repository migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("deduplicates legacy remotes per company, redacts credentials, and preserves local workspaces", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-repositories-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`ALTER TABLE "project_workspaces" DROP COLUMN "repository_id"`;
    await sql`DROP TABLE "agent_repository_grants"`;
    await sql`DROP TABLE "project_repositories"`;
    await sql`DROP TABLE "repositories"`;
    await sql`DROP TABLE "repository_connections"`;

    const companyA = randomUUID();
    const companyB = randomUUID();
    const projectA1 = randomUUID();
    const projectA2 = randomUUID();
    const projectB = randomUUID();
    const remoteWorkspaceA1 = randomUUID();
    const remoteWorkspaceA2 = randomUUID();
    const localWorkspaceA = randomUUID();
    const remoteWorkspaceB = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyA}, 'A', 'RA'), (${companyB}, 'B', 'RB')
    `;
    await sql`
      INSERT INTO "projects" ("id", "company_id", "name")
      VALUES
        (${projectA1}, ${companyA}, 'A One'),
        (${projectA2}, ${companyA}, 'A Two'),
        (${projectB}, ${companyB}, 'B One')
    `;
    await sql`
      INSERT INTO "project_workspaces" (
        "id", "company_id", "project_id", "name", "source_type", "cwd", "repo_url", "is_primary"
      ) VALUES
        (${remoteWorkspaceA1}, ${companyA}, ${projectA1}, 'Remote One', 'git_repo', NULL,
          'https://oauth-user:top-secret@github.com/Acme/Shared.git?access_token=also-secret', true),
        (${remoteWorkspaceA2}, ${companyA}, ${projectA2}, 'Remote Two', 'git_repo', NULL,
          'git@github.com:Acme/Shared.git', true),
        (${localWorkspaceA}, ${companyA}, ${projectA1}, 'Local', 'local_path', '/workspace/local', NULL, false),
        (${remoteWorkspaceB}, ${companyB}, ${projectB}, 'Remote Other Company', 'git_repo', NULL,
          'https://github.com/Acme/Shared.git', true)
    `;

    await applyPendingMigrations(database.connectionString);

    const repositoryCounts = await sql<{ company_id: string; count: string }[]>`
      SELECT "company_id", count(*)::text AS "count"
      FROM "repositories"
      GROUP BY "company_id"
      ORDER BY "company_id"
    `;
    expect(new Map(repositoryCounts.map((row) => [row.company_id, row.count]))).toEqual(
      new Map([[companyA, "1"], [companyB, "1"]]),
    );

    const companyALinks = await sql<{ project_id: string }[]>`
      SELECT "project_id" FROM "project_repositories"
      WHERE "company_id" = ${companyA}
      ORDER BY "project_id"
    `;
    expect(companyALinks.map((row) => row.project_id).sort()).toEqual([projectA1, projectA2].sort());

    const workspaces = await sql<{ id: string; repository_id: string | null; repo_url: string | null }[]>`
      SELECT "id", "repository_id", "repo_url"
      FROM "project_workspaces"
      WHERE "company_id" = ${companyA}
      ORDER BY "id"
    `;
    const byId = new Map(workspaces.map((row) => [row.id, row]));
    expect(byId.get(remoteWorkspaceA1)?.repository_id).toBeTruthy();
    expect(byId.get(remoteWorkspaceA2)?.repository_id).toBe(byId.get(remoteWorkspaceA1)?.repository_id);
    expect(byId.get(remoteWorkspaceA1)?.repo_url).toBe("https://github.com/Acme/Shared.git");
    expect(byId.get(remoteWorkspaceA1)?.repo_url).not.toContain("secret");
    expect(byId.get(remoteWorkspaceA2)?.repo_url).toBe("git@github.com:Acme/Shared.git");
    expect(byId.get(localWorkspaceA)?.repository_id).toBeNull();
    expect(byId.get(localWorkspaceA)?.repo_url).toBeNull();

    const [metadata] = await sql<{ metadata: { credentialRedacted?: boolean } }[]>`
      SELECT "provider_metadata" AS "metadata"
      FROM "repositories"
      WHERE "company_id" = ${companyA}
    `;
    expect(metadata?.metadata.credentialRedacted).toBe(true);
  }, 30_000);
});
