import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySkillSources, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, projectAccessMembers, projects, projectSkillSources } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { PAPERCLIP_FEEDBACK_SKILL_KEYS, PAPERCLIP_OPERATIONAL_SKILL_KEY } from "@paperclipai/adapter-utils/server-utils";
import { companySkillService } from "../services/company-skills.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { skillAccessService, withSkillActor } from "../services/skill-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("selected runtime skill reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const companyId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-skill-selection-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-skill-selection-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    await db.insert(companies).values({ id: companyId, name: "Runtime selection", issuePrefix: `RS${companyId.slice(0, 6)}` });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacy;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("delivers the real legacy operational selection on cold and repeated reads", async () => {
    for (const phase of ["cold", "warm", "repeated"] as const) {
      const select = vi.spyOn(db, "select");
      const insert = vi.spyOn(db, "insert");
      const update = vi.spyOn(db, "update");
      const cpu = process.cpuUsage();
      const started = performance.now();
      try {
        const entries = await companySkillService(db).listRuntimeSkillEntries(companyId, {
          selectionConfig: { paperclipSkillSync: { desiredSkills: [] } },
          includeLegacy: true,
          snapshotLatest: true,
        });
        console.info(JSON.stringify({ phase, elapsedMs: performance.now() - started,
          cpuMicros: process.cpuUsage(cpu), selectBuilderCalls: select.mock.calls.length,
          insertBuilderCalls: insert.mock.calls.length, updateBuilderCalls: update.mock.calls.length,
          delivered: entries.map(entry => entry.key) }));
        expect(entries.map(entry => entry.key).sort()).toEqual([PAPERCLIP_OPERATIONAL_SKILL_KEY, ...PAPERCLIP_FEEDBACK_SKILL_KEYS].sort());
        expect(entries.every(entry => entry.sourceStatus === "available" && entry.versionId)).toBe(true);
      } finally {
        select.mockRestore();
        insert.mockRestore();
        update.mockRestore();
      }
    }
  }, 30_000);

  it("bounds project-source authorization work without caching changed permissions", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Selected runtime reader", adapterType: "codex_local" }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, membershipRole: "member" });
    const actor: AuthorizationActor = { type: "agent", agentId: agent!.id, companyId, source: "agent_jwt" };
    const counts: number[] = [];
    let revoked: { sourceId: string; projectId: string } | undefined;
    for (const count of [5, 75]) {
      const rows = await db.insert(projects).values(Array.from({ length: count }, (_, index) => ({
        id: randomUUID(), companyId, name: `Runtime source ${count}/${index}`, visibility: "private",
      }))).returning();
      const sources = await db.insert(companySkillSources).values(rows.map(row => ({
        id: randomUUID(), companyId, repositoryUrl: `https://github.com/fixture/${row.id}`, fullName: `fixture/${row.id}`,
        trackingRef: "main", accessScope: "projects" as const,
      }))).returning();
      await db.insert(projectSkillSources).values(rows.map((row, index) => ({
        companyId, projectId: row.id, sourceId: sources[index]!.id, repositoryUrl: sources[index]!.repositoryUrl,
        trackingRef: "main", status: "ready" as const,
      })));
      await db.insert(projectAccessMembers).values(rows.filter((_, index) => index % 2 === 0).map(row => ({
        companyId, projectId: row.id, subjectType: "agent", subjectId: agent!.id,
      })));
      revoked = { sourceId: sources[0]!.id, projectId: rows[0]!.id };
      const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.companyId, companyId));
      const expected = new Set<string>();
      for (const binding of bindings) {
        const decision = await authorizationService(db).decide({ actor, action: "project:read",
          resource: { type: "project", companyId, projectId: binding.projectId } });
        if (decision.allowed) expected.add(binding.sourceId!);
      }
      const select = vi.spyOn(db, "select");
      const started = performance.now();
      try {
        const visible = await skillAccessService(db, actor).visibleSourceIds(companyId);
        counts.push(select.mock.calls.length);
        console.info(JSON.stringify({ phase: "actor-source-authorization", projects: bindings.length,
          elapsedMs: performance.now() - started, selectBuilderCalls: select.mock.calls.length }));
        expect(new Set(visible)).toEqual(expected);
      } finally { select.mockRestore(); }
    }
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, revoked!.projectId),
      eq(projectAccessMembers.subjectId, agent!.id)));
    expect(await skillAccessService(db, actor).visibleSourceIds(companyId)).not.toContain(revoked!.sourceId);
    const select = vi.spyOn(db, "select");
    const runtimeStarted = performance.now();
    try {
      const entries = await withSkillActor(actor, () => companySkillService(db).listRuntimeSkillEntries(companyId, {
        selectionConfig: { paperclipSkillSync: { desiredSkills: [] } }, includeLegacy: true, snapshotLatest: true,
      }));
      console.info(JSON.stringify({ phase: "actor-runtime", projects: 80, elapsedMs: performance.now() - runtimeStarted,
        selectBuilderCalls: select.mock.calls.length }));
      expect(entries.map(entry => entry.key).sort()).toEqual([PAPERCLIP_OPERATIONAL_SKILL_KEY, ...PAPERCLIP_FEEDBACK_SKILL_KEYS].sort());
    } finally { select.mockRestore(); }
    expect(counts[1]).toBeLessThanOrEqual(counts[0]! + 2);
  }, 30_000);
});
