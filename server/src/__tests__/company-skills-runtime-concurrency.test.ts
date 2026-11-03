import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySkills, companySkillSources, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  projectAccessMembers, projects, projectSkillSources } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { PAPERCLIP_FEEDBACK_SKILL_KEYS, PAPERCLIP_OPERATIONAL_SKILL_KEY } from "@paperclipai/adapter-utils/server-utils";
import { companySkillService } from "../services/company-skills.js";
import { withSkillActor } from "../services/skill-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("concurrent runtime skill preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-skill-concurrency-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-skill-concurrency-"));
    process.env.PAPERCLIP_HOME = home;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("shares an in-flight inventory refresh across service instances before snapshot locking", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Concurrent skill readers", issuePrefix: `SC${companyId.slice(0, 6)}` });
    const select = vi.spyOn(db, "select");
    try {
      const selections = await Promise.all(Array.from({ length: 6 }, () => companySkillService(db).listRuntimeSkillEntries(companyId, {
        selectionConfig: { paperclipSkillSync: { desiredSkills: [] } }, includeLegacy: true, snapshotLatest: true,
      })));
      for (const entries of selections) {
        expect(entries.map(entry => entry.key).sort()).toEqual([PAPERCLIP_OPERATIONAL_SKILL_KEY, ...PAPERCLIP_FEEDBACK_SKILL_KEYS].sort());
        expect(entries.every(entry => entry.sourceStatus === "available" && entry.versionId)).toBe(true);
      }
      expect(select.mock.calls.filter(([fields]) => fields && Object.keys(fields).length === 1 && fields.id === companies.id)).toHaveLength(1);
      await companySkillService(db).listRuntimeSkillEntries(companyId, {
        selectionConfig: { paperclipSkillSync: { desiredSkills: [] } }, includeLegacy: true, snapshotLatest: true,
      });
      expect(select.mock.calls.filter(([fields]) => fields && Object.keys(fields).length === 1 && fields.id === companies.id)).toHaveLength(2);
    } finally { select.mockRestore(); }
  }, 30_000);

  it("shares inventory work without sharing actor visibility or retaining revoked project access", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Separate skill readers", issuePrefix: `SV${companyId.slice(0, 6)}` });
    const readers = await db.insert(agents).values(["Allowed", "Denied"].map(name => ({ companyId, name, adapterType: "codex_local" }))).returning();
    await db.insert(companyMemberships).values(readers.map(reader => ({ companyId, principalType: "agent", principalId: reader.id, membershipRole: "member" })));
    const [project] = await db.insert(projects).values({ companyId, name: "Private skill source", visibility: "private" }).returning();
    const [source] = await db.insert(companySkillSources).values({ companyId, repositoryUrl: "https://github.com/fixture/private-skills",
      fullName: "fixture/private-skills", trackingRef: "main", accessScope: "projects" }).returning();
    await db.insert(projectSkillSources).values({ companyId, projectId: project!.id, sourceId: source!.id,
      repositoryUrl: source!.repositoryUrl, trackingRef: "main", status: "ready" });
    await db.insert(projectAccessMembers).values({ companyId, projectId: project!.id, subjectType: "agent", subjectId: readers[0]!.id });
    const skill = await companySkillService(db).createLocalSkill(companyId, { name: "Private local skill" });
    await db.update(companySkills).set({ accessSourceId: source!.id }).where(eq(companySkills.id, skill.id));
    const read = (agentId: string) => withSkillActor({ type: "agent", companyId, agentId, source: "agent_jwt" },
      () => companySkillService(db).listRuntimeSkillEntries(companyId, { onlyKeys: new Set([skill.key]), snapshotLatest: true }));
    const [allowed, denied] = await Promise.all(readers.map(reader => read(reader.id)));
    expect(allowed!.map(entry => entry.key)).toEqual([skill.key]);
    expect(allowed![0]!.sourceStatus).toBe("available");
    expect(denied).toEqual([]);
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, project!.id), eq(projectAccessMembers.subjectId, readers[0]!.id)));
    expect(await read(readers[0]!.id)).toEqual([]);
  });
});
