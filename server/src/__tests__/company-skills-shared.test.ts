import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companySkills, createDb, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { SHARED_SKILLS_REPOSITORY_ENV, SHARED_SKILLS_TOKEN_ENV, refreshSharedSkills } from "../services/shared-skills-source.js";
import { __resetSharedSkillsTokenForTests } from "../secrets/shared-skills-token.js";
import type { GitSkillSnapshot } from "../services/skill-source-git-snapshot.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const env = { [SHARED_SKILLS_TOKEN_ENV]: "unit-test-token", [SHARED_SKILLS_REPOSITORY_ENV]: "example/skills-repo" };

function snapshot(commitSha: string, names: string[]): GitSkillSnapshot {
  const blobs = names.map((name) => ({ path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: Shared ${name}\n---\nBody of ${name}` }));
  return {
    commitSha,
    entries: blobs.map((b) => ({ path: b.path, type: "blob", mode: "100644", sha: "0".repeat(40), size: b.content.length })),
    readBlob: async (entry) => Buffer.from(blobs.find((b) => b.path === entry.path)!.content),
    release: async () => undefined,
  };
}

describeEmbeddedPostgres("shared skills in the company library", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  let oldHome: string | undefined;
  let oldInstance: string | undefined;
  let oldEnv: { token: string | undefined; repository: string | undefined } = { token: undefined, repository: undefined };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shared-skills-");
    oldHome = process.env.PAPERCLIP_HOME;
    oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shared-skills-home-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    oldEnv = { token: process.env[SHARED_SKILLS_TOKEN_ENV], repository: process.env[SHARED_SKILLS_REPOSITORY_ENV] };
    process.env[SHARED_SKILLS_REPOSITORY_ENV] = env[SHARED_SKILLS_REPOSITORY_ENV];
    __resetSharedSkillsTokenForTests(env[SHARED_SKILLS_TOKEN_ENV]);
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companySkills);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
    await fs.rm(path.join(home, "instances", "default", "shared-skills"), { recursive: true, force: true });
  });

  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    __resetSharedSkillsTokenForTests(null);
    if (oldEnv.repository === undefined) delete process.env[SHARED_SKILLS_REPOSITORY_ENV]; else process.env[SHARED_SKILLS_REPOSITORY_ENV] = oldEnv.repository;
    if (home) await fs.rm(home, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Shared skills", issuePrefix: `S${id.slice(0, 6)}` });
    return id;
  }
  const sharedKeys = async (companyId: string) =>
    (await svc.list(companyId)).map((skill) => skill.key).filter((key) => key.startsWith("shared/")).sort();

  it("adds nothing when the feature is unset, even with an old snapshot on disk", async () => {
    await refreshSharedSkills({ env, openSnapshot: async () => snapshot("a".repeat(40), ["alpha"]) });
    const id = await company();
    __resetSharedSkillsTokenForTests(null);
    try {
      expect(await sharedKeys(id)).toEqual([]);
    } finally {
      __resetSharedSkillsTokenForTests(env[SHARED_SKILLS_TOKEN_ENV]);
    }
    expect(await sharedKeys(id)).toEqual(["shared/alpha"]);
  });

  it("adds nothing before the first download", async () => {
    const id = await company();
    expect(await sharedKeys(id)).toEqual([]);
  });

  it("gives every company the shared skills, creates no connection or install, and leaves git identity unaffected", async () => {
    const [one, two] = [await company(), await company()];
    await refreshSharedSkills({ env, openSnapshot: async () => snapshot("a".repeat(40), ["alpha", "beta"]) });
    expect(await sharedKeys(one)).toEqual(["shared/alpha", "shared/beta"]);
    expect(await sharedKeys(two)).toEqual(["shared/alpha", "shared/beta"]);
    expect(await sharedKeys(one)).toEqual(["shared/alpha", "shared/beta"]); // idempotent
    const [row] = await db.select().from(companySkills).where(eq(companySkills.key, "shared/alpha")).limit(1);
    expect(row).toMatchObject({ slug: "alpha", sourceType: "local_path" });
    expect(await db.select().from(toolConnections)).toEqual([]);
    expect(await db.select().from(toolConnectionInstalls)).toEqual([]);
    expect(await resolveManagedGitHubIdentitySelection(db, one, { agentId: randomUUID() })).toMatchObject({ configured: false });
  });

  it("drops a skill removed from the shared repository", async () => {
    const id = await company();
    await refreshSharedSkills({ env, openSnapshot: async () => snapshot("a".repeat(40), ["alpha", "beta"]) });
    expect(await sharedKeys(id)).toEqual(["shared/alpha", "shared/beta"]);
    await refreshSharedSkills({ env, openSnapshot: async () => snapshot("b".repeat(40), ["alpha"]) });
    expect(await sharedKeys(id)).toEqual(["shared/alpha"]);
  });
});
