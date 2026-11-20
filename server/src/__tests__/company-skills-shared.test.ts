import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
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

  async function digestTree(dir: string): Promise<string> {
    const hash = createHash("sha256");
    const walk = async (current: string): Promise<void> => {
      for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        hash.update(path.relative(dir, full));
        if (entry.isDirectory()) await walk(full); else hash.update(await fs.readFile(full));
      }
    };
    await walk(dir);
    return hash.digest("hex");
  }

  async function sharedSkill(companyId: string, slug = "alpha") {
    const [row] = await db.select().from(companySkills).where(eq(companySkills.key, `shared/${slug}`)).limit(1);
    void companyId;
    return row!;
  }

  describe("read-only enforcement", () => {
    async function setup() {
      await refreshSharedSkills({ env, openSnapshot: async () => snapshot("a".repeat(40), ["alpha"]) });
      const [one, two] = [await company(), await company()];
      await sharedKeys(one);
      await sharedKeys(two);
      const rows = await db.select().from(companySkills).where(eq(companySkills.key, "shared/alpha"));
      const rowOne = rows.find((r) => r.companyId === one)!;
      const rowTwo = rows.find((r) => r.companyId === two)!;
      const directory = rowOne.sourceLocator!;
      return { one, two, rowOne, rowTwo, directory, before: await digestTree(directory) };
    }

    it("refuses to edit, create, delete or rename a shared skill and leaves the shared directory unchanged", async () => {
      const { one, rowOne, directory, before } = await setup();
      await expect(svc.updateFile(one, rowOne.id, "SKILL.md", "---\nname: alpha\n---\nINJECTED")).rejects.toMatchObject({ details: { code: "shared_skill_read_only" } });
      await expect(svc.updateFile(one, rowOne.id, "extra.md", "new file")).rejects.toMatchObject({ details: { code: "shared_skill_read_only" } });
      await expect(svc.deleteFile(one, rowOne.id, { path: "SKILL.md", target: "file" })).rejects.toMatchObject({ details: { code: "shared_skill_read_only" } });
      await expect(svc.renameSkill(one, rowOne.id, { name: "Renamed" })).rejects.toThrow();
      await expect(svc.installUpdate(one, rowOne.id, { force: true })).rejects.toMatchObject({ details: { code: "shared_skill_read_only" } });
      expect(await digestTree(directory)).toBe(before);
      expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).not.toContain("INJECTED");
    });

    it("keeps a shared skill read-only even if its marker is lost, because of where it lives", async () => {
      const { one, rowOne, directory, before } = await setup();
      await db.update(companySkills).set({ metadata: { sourceKind: "local_path" } }).where(eq(companySkills.id, rowOne.id));
      await expect(svc.updateFile(one, rowOne.id, "SKILL.md", "x")).rejects.toMatchObject({ details: { code: "shared_skill_read_only" } });
      expect(await digestTree(directory)).toBe(before);
    });

    it("an attempted edit in one company never changes what another company sees", async () => {
      const { one, two, rowOne, rowTwo, directory } = await setup();
      await expect(svc.updateFile(one, rowOne.id, "SKILL.md", "tampered")).rejects.toThrow();
      const seen = await svc.readFile(two, rowTwo.id, "SKILL.md");
      expect(seen?.content).toContain("Body of alpha");
      expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toContain("Body of alpha");
    });

    it("reports a shared skill as not editable", async () => {
      const { one, rowOne } = await setup();
      const file = await svc.readFile(one, rowOne.id, "SKILL.md");
      expect(file?.editable).toBe(false);
      const detail = await svc.detail(one, rowOne.id);
      expect(detail?.editable).toBe(false);
      expect(detail?.editableReason).toMatch(/Fork this skill/);
    });

    it("still lets a company fork a shared skill into its own managed copy and edit that", async () => {
      const { one, rowOne, directory, before } = await setup();
      const { skill: fork } = await svc.forkSkill(one, rowOne.id, {});
      const managedRoot = path.join(home, "instances", "default", "skills", one);
      expect(fork.sourceLocator!.startsWith(managedRoot)).toBe(true);
      expect(fork.key).toBe(`company/${one}/${fork.slug}`);
      const edited = await svc.updateFile(one, fork.id, "SKILL.md", "---\nname: alpha\ndescription: mine\n---\nMy own text");
      expect(edited.content).toContain("My own text");
      expect(await fs.readFile(path.join(fork.sourceLocator!, "SKILL.md"), "utf8")).toContain("My own text");
      expect(await digestTree(directory)).toBe(before);
    });
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
