import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, companies, companyMemberships, companySkills, companySkillVersions, companySkillSources, projectSkillSources, projects, projectAccessMembers, createDb, instanceSettings, pluginConfig, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("skill runtime invalidation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let companyId: string;
  let pluginId: string;
  let skillId: string;
  let key: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-skills-"); db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-skills-home-"));
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(home, { recursive: true, force: true }); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    companyId = randomUUID(); pluginId = randomUUID(); skillId = randomUUID(); key = `company/${companyId}/fixture`;
    await db.insert(companies).values({ id: companyId, name: "Skill runtime fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready", manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(pluginConfig).values({ companyId, pluginId, configJson: {} });
    await db.insert(companySkills).values({ id: skillId, companyId, key, slug: "fixture", name: "Fixture", markdown: "old", sourceType: "github", sourceLocator: "https://github.com/fixture/skills" });
  });
  async function agent(selection: unknown[] = [key], company = companyId) {
    const [created] = await db.insert(agents).values({ companyId: company, name: randomUUID(), adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId], adapterConfig: { paperclipSkillSync: { desiredSkills: selection } } }).returning();
    return created;
  }
  const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);
  async function publish(content: string, revision: number) {
    return db.transaction(async tx => {
      const [version] = await tx.insert(companySkillVersions).values({ companyId, companySkillId: skillId, revisionNumber: revision, fileInventory: [{ path: "SKILL.md", kind: "skill", content }] }).returning();
      await tx.update(companySkills).set({ markdown: content, currentVersionId: version.id }).where(eq(companySkills.id, skillId));
      return version;
    });
  }
  it("invalidates string, structured, and legacy alias assignments while leaving other agents untouched", async () => {
    const first = await agent(); const second = await agent([{ key, versionId: randomUUID() }]); const alias = await agent(["fixture"]);
    await agent([]); await agent(["unrelated"]);
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other company", issuePrefix: `X${otherCompany.slice(0, 6)}` });
    await agent([key], otherCompany);
    const before = (await events()).length;
    await db.update(companySkills).set({ markdown: "changed" }).where(eq(companySkills.id, skillId));
    expect((await events()).slice(before).map(row => row.resourceId).sort()).toEqual([first.id, second.id, alias.id].sort());
    const after = (await events()).length;
    await db.update(companySkills).set({ starCount: 9, updatedAt: new Date() }).where(eq(companySkills.id, skillId));
    expect(await events()).toHaveLength(after);
  });
  it.each(["paperclip", "complain", "suggestion-box"])("invalidates implicit legacy %s skills with an empty selection", async slug => {
    const legacy = await agent([]);
    const native = await agent([]);
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, legacy.id));
    const [skill] = await db.insert(companySkills).values({ companyId, key: `paperclipai/paperclip/${slug}`, slug, name: slug, markdown: "implicit" }).returning();
    const before = (await events()).length;
    await db.update(companySkills).set({ markdown: "changed implicit" }).where(eq(companySkills.id, skill.id));
    expect((await events()).slice(before)).toEqual([expect.objectContaining({ resourceId: legacy.id })]);
    await db.delete(companySkills).where(eq(companySkills.id, skill.id));
    expect((await events()).slice(before).map(row => row.resourceId)).toEqual([legacy.id, legacy.id]);
    expect((await events()).slice(before).some(row => row.resourceId === native.id)).toBe(false);
  });
  it("captures companion-file changes, rename, and deletion using both old and new references", async () => {
    const old = await agent(); const next = await agent([`${key}-next`]);
    const before = (await events()).length;
    await db.update(companySkills).set({ fileInventory: [{ path: "references/guide.md", kind: "reference", size: 5 }] }).where(eq(companySkills.id, skillId));
    expect((await events()).slice(before)).toEqual([expect.objectContaining({ resourceId: old.id })]);
    const renamed = (await events()).length;
    await db.update(companySkills).set({ key: `${key}-next`, slug: "next" }).where(eq(companySkills.id, skillId));
    expect((await events()).slice(renamed).map(row => row.resourceId).sort()).toEqual([old.id, next.id].sort());
    const deleted = (await events()).length;
    await db.delete(companySkills).where(eq(companySkills.id, skillId));
    expect((await events()).slice(deleted)).toEqual([expect.objectContaining({ resourceId: next.id })]);
  });
  it("invalidates private-source access changes while ignoring source polling bookkeeping", async () => {
    const assigned = await agent();
    const [project] = await db.insert(projects).values({ companyId, name: "Private source", visibility: "private" }).returning();
    const [source] = await db.insert(companySkillSources).values({ companyId, repositoryUrl: "https://github.com/fixture/private", fullName: "fixture/private", trackingRef: "HEAD", accessScope: "projects" }).returning();
    await db.update(companySkills).set({ accessSourceId: source.id }).where(eq(companySkills.id, skillId));
    const [binding] = await db.insert(projectSkillSources).values({ companyId, projectId: project.id, sourceId: source.id, repositoryUrl: source.repositoryUrl, trackingRef: "HEAD" }).returning();
    await db.insert(agents).values(Array.from({ length: 250 }, () => ({ companyId, name: randomUUID(), adapterType: "paperclip_runner", adapterConfig: { paperclipSkillSync: { desiredSkills: ["unrelated"] } } })));
    const before = (await events()).length;
    await db.update(projectSkillSources).set({ nextSyncAt: new Date(), failureCount: 1 }).where(eq(projectSkillSources.id, binding.id));
    expect(await events()).toHaveLength(before);
    const [access] = await db.insert(projectAccessMembers).values({ companyId, projectId: project.id, subjectType: "agent", subjectId: assigned.id }).returning();
    expect(await events()).toHaveLength(before + 1);
    await db.delete(projectAccessMembers).where(eq(projectAccessMembers.id, access.id));
    expect(await events()).toHaveLength(before + 2);
    await db.update(projects).set({ visibility: "open" }).where(eq(projects.id, project.id));
    expect(await events()).toHaveLength(before + 3);
    expect((await events()).slice(before).map(row => row.resourceId)).toEqual([assigned.id, assigned.id, assigned.id]);
    const [unrelatedProject] = await db.insert(projects).values({ companyId, name: "Unrelated", visibility: "private" }).returning();
    await db.insert(projectAccessMembers).values({ companyId, projectId: unrelatedProject.id, subjectType: "agent", subjectId: assigned.id });
    await db.update(projects).set({ visibility: "open" }).where(eq(projects.id, unrelatedProject.id));
    expect(await events()).toHaveLength(before + 3);
    await db.update(projectSkillSources).set({ sourceId: null }).where(eq(projectSkillSources.id, binding.id));
    expect((await events()).slice(before + 3)).toEqual([expect.objectContaining({ resourceId: assigned.id })]);
  });
  it("keeps publication and invalidation in the same transaction", async () => {
    await agent(); const before = await events();
    await expect(db.transaction(async tx => {
      await tx.update(companySkills).set({ markdown: "rolled back" }).where(eq(companySkills.id, skillId));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await events()).toEqual(before);
    expect((await db.select().from(companySkills).where(eq(companySkills.id, skillId)))[0].markdown).toBe("old");
  });
  it("invalidates policy-only project access changes and removes or restores the selected skill", async () => {
    const assigned = await agent();
    await agent([]);
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: assigned.id, status: "active" });
    const [project] = await db.insert(projects).values({ companyId, name: "Policy-bound source", visibility: "open" }).returning();
    const [source] = await db.insert(companySkillSources).values({ companyId, repositoryUrl: "https://github.com/fixture/policy", fullName: "fixture/policy", trackingRef: "HEAD", accessScope: "projects" }).returning();
    await db.insert(projectSkillSources).values({ companyId, projectId: project.id, sourceId: source.id, repositoryUrl: source.repositoryUrl, trackingRef: "HEAD" });
    await db.update(companySkills).set({ accessSourceId: source.id }).where(eq(companySkills.id, skillId));
    await publish("policy-scoped content", 1);
    const state = () => pluginAgentRuntimeState(db, pluginId, companyId, assigned.id);
    expect((await state())!.skills.map(skill => skill.key)).toEqual([key]);
    const before = (await events()).length;
    const restricted = { authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, projectIds: [] } } };
    await db.update(projects).set({ executionWorkspacePolicy: restricted }).where(eq(projects.id, project.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([assigned.id]);
    expect((await state())!.skills).toEqual([]);
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, project.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([assigned.id, assigned.id]);
    expect((await state())!.skills.map(skill => skill.key)).toEqual([key]);
    const restored = (await events()).length;
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, project.id));
    expect(await events()).toHaveLength(restored);
  });
  it("resolves immutable pinned and latest skill sources and removes unassigned skills", async () => {
    await instanceSettingsService(db).getExperimental();
    await db.update(instanceSettings).set({ experimental: { enableBetaSkills: true } });
    const first = await publish("first version", 1);
    const pinned = await agent([{ key, versionId: first.id }]);
    const latest = await agent();
    const second = await publish("second version", 2);
    const pinnedState = await pluginAgentRuntimeState(db, pluginId, companyId, pinned.id);
    const latestState = await pluginAgentRuntimeState(db, pluginId, companyId, latest.id);
    expect(pinnedState!.skills).toEqual([expect.objectContaining({ key, versionId: first.id })]);
    expect(latestState!.skills).toEqual([expect.objectContaining({ key, versionId: second.id })]);
    expect(await fs.readFile(path.join(pinnedState!.skills[0].source, "SKILL.md"), "utf8")).toBe("first version");
    expect(await fs.readFile(path.join(latestState!.skills[0].source, "SKILL.md"), "utf8")).toBe("second version");
    await db.update(agents).set({ adapterConfig: { paperclipSkillSync: { desiredSkills: [] } } }).where(eq(agents.id, latest.id));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, latest.id))!.skills).toEqual([]);
  });
});
