import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0175_nested_skill_folders.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("nested skill folders migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("backfills existing folders, bundled skills, and project scan skills", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-nested-folders-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP INDEX IF EXISTS "folders_company_kind_parent_position_idx"`;
    await sql`DROP INDEX IF EXISTS "folders_company_kind_system_key_uq"`;
    await sql`DROP INDEX IF EXISTS "folders_company_kind_root_slug_uq"`;
    await sql`DROP INDEX IF EXISTS "folders_company_kind_parent_slug_uq"`;
    await sql`ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "folders_company_kind_parent_slug_uq"`;
    await sql`ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "folders_parent_id_folders_id_fk"`;
    await sql`ALTER TABLE "folders" DROP COLUMN IF EXISTS "system_key"`;
    await sql`ALTER TABLE "folders" DROP COLUMN IF EXISTS "slug"`;
    await sql`ALTER TABLE "folders" DROP COLUMN IF EXISTS "parent_id"`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_name_uq" ON "folders" ("company_id", "kind", "name")`;

    const companyId = randomUUID();
    const projectId = randomUUID();
    const existingFolderId = randomUUID();
    const squattedBundledId = randomUUID();
    const squattedProjectsId = randomUUID();
    const bundledSkillId = randomUUID();
    const projectSkillId = randomUUID();
    const unfiledSkillId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Paperclip', 'PAP')
    `;
    await sql`
      INSERT INTO "projects" ("id", "company_id", "name")
      VALUES (${projectId}, ${companyId}, 'Agent Platform')
    `;
    await sql`
      INSERT INTO "folders" ("id", "company_id", "kind", "name", "position")
      VALUES
        (${existingFolderId}, ${companyId}, 'skill', 'Team Notes', 0),
        (${squattedBundledId}, ${companyId}, 'skill', 'Bundled', 1),
        (${squattedProjectsId}, ${companyId}, 'skill', 'Projects', 2)
    `;
    await sql`
      INSERT INTO "company_skills" ("id", "company_id", "key", "slug", "name", "markdown", "metadata")
      VALUES
        (${bundledSkillId}, ${companyId}, 'paperclipai/bundled/software-development/review', 'review', 'Review', '# Review', '{"sourceKind":"paperclip_bundled"}'::jsonb),
        (${projectSkillId}, ${companyId}, 'company/project-skill', 'project-skill', 'Project Skill', '# Project', ${sql.json({ sourceKind: "project_scan", projectId, projectName: "Agent Platform" })}),
        (${unfiledSkillId}, ${companyId}, 'company/unfiled', 'unfiled', 'Unfiled', '# Unfiled', '{}'::jsonb)
    `;

    await applyPendingMigrations(database.connectionString);

    const folderRows = await sql<{
      id: string;
      parent_id: string | null;
      slug: string;
      system_key: string | null;
    }[]>`
      SELECT "id", "parent_id", "slug", "system_key"
      FROM "folders"
      WHERE "company_id" = ${companyId}
      ORDER BY "slug"
    `;
    expect(folderRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: existingFolderId, slug: "team-notes", parent_id: null }),
      expect.objectContaining({ id: squattedBundledId, slug: `bundled-${squattedBundledId.replace(/-/g, "").slice(0, 8)}`, system_key: null }),
      expect.objectContaining({ id: squattedProjectsId, slug: `projects-${squattedProjectsId.replace(/-/g, "").slice(0, 8)}`, system_key: null }),
      expect.objectContaining({ slug: "bundled", system_key: "bundled", parent_id: null }),
      expect.objectContaining({ slug: "software-development", system_key: "bundled:software-development" }),
      expect.objectContaining({ slug: "projects", system_key: "projects", parent_id: null }),
      expect.objectContaining({ slug: "agent-platform", system_key: `project:${projectId}` }),
    ]));

    const skills = await sql<{ id: string; folder_id: string | null; folder_slug: string | null }[]>`
      SELECT skill."id", skill."folder_id", folder."slug" AS folder_slug
      FROM "company_skills" AS skill
      LEFT JOIN "folders" AS folder ON folder."id" = skill."folder_id"
      WHERE skill."company_id" = ${companyId}
      ORDER BY skill."id"
    `;
    expect(skills.find((skill) => skill.id === bundledSkillId)).toMatchObject({ folder_slug: "software-development" });
    expect(skills.find((skill) => skill.id === projectSkillId)).toMatchObject({ folder_slug: "agent-platform" });
    expect(skills.find((skill) => skill.id === unfiledSkillId)).toMatchObject({ folder_id: null, folder_slug: null });

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT "indexname", "indexdef"
      FROM "pg_indexes"
      WHERE "tablename" = 'folders'
        AND "indexname" IN ('folders_company_kind_root_slug_uq', 'folders_company_kind_parent_slug_uq')
      ORDER BY "indexname"
    `;
    expect(indexes).toHaveLength(2);
    expect(indexes.map((index) => index.indexdef).join("\n")).not.toContain("NULLS NOT DISTINCT");
    expect(indexes.find((index) => index.indexname === "folders_company_kind_root_slug_uq")?.indexdef)
      .toContain("WHERE (parent_id IS NULL)");
    expect(indexes.find((index) => index.indexname === "folders_company_kind_parent_slug_uq")?.indexdef)
      .toContain("WHERE (parent_id IS NOT NULL)");
  }, 30_000);
});
