import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { activityLog, companyMemberships, heartbeatRuns, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { companySkillPolicyService } from "../company-skill-policy.js";
import { companySkillService } from "../company-skills.js";

describe("runner update_skill through the real skill API", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  let home: string;
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    home = await mkdtemp(join(tmpdir(), "paperclip-update-skill-"));
    process.env.PAPERCLIP_HOME = home;
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture(options: Parameters<typeof server.fixture>[0] = {}) {
    const result = await server.fixture(options);
    await server.db.insert(companyMemberships).values({ companyId: result.companyId, principalType: "agent", principalId: result.agentId, status: "active", membershipRole: "member" });
    const skill = await companySkillService(server.db).createLocalSkill(result.companyId, {
      name: "release-review", description: "Review releases.",
      markdown: "---\nname: release-review\ndescription: Review releases.\n---\n\n# Review\nInspect the release.\n",
    });
    const args = { skillId: skill.id, expectedVersionId: skill.currentVersionId, idempotencyKey: randomUUID(),
      markdown: "---\nname: release-review\ndescription: Review releases.\n---\n\n# Review\nInspect the release and its tests.\n" };
    return { ...result, skill, args };
  }

  it("persists exactly one version and attributed activity across retries and a replacement run", async () => {
    const testFixture = await fixture();
    const { authority, args, companyId, skill, issueId } = testFixture;
    expect(authority.definitions().some(tool => tool.name === "update_skill")).toBe(true);
    const first = await authority.execute({ tool: "update_skill", callId: "first", arguments: args });
    const second = await authority.execute({ tool: "update_skill", callId: "retry", arguments: args });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ skillId: skill.id, path: "SKILL.md", versionId: expect.any(String) });
    const replacementRunId = randomUUID();
    await server.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, testFixture.runId));
    await server.db.insert(heartbeatRuns).values({ id: replacementRunId, companyId, agentId: testFixture.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await server.db.update(issues).set({ executionRunId: replacementRunId }).where(eq(issues.id, issueId));
    const replacement = new PaperclipRunnerToolAuthority(server.db, { ...testFixture, runId: replacementRunId });
    expect(await replacement.execute({ tool: "update_skill", callId: "replacement", arguments: args })).toEqual(first);
    expect(await companySkillService(server.db).listVersions(companyId, skill.id)).toHaveLength(2);
    expect((await server.db.select().from(activityLog).where(eq(activityLog.action, "company.skill_file_updated")))
      .filter(event => event.entityId === skill.id))
      .toEqual([expect.objectContaining({ entityId: skill.id, details: expect.objectContaining({ sourceIssueId: issueId, versionId: (first as { versionId: string }).versionId }) })]);
    await expect(replacement.execute({ tool: "update_skill", callId: "changed-key", arguments: { ...args, markdown: args.markdown + "More." } })).rejects.toThrow(/different inputs/);
    await expect(replacement.execute({ tool: "update_skill", callId: "stale", arguments: { ...args, idempotencyKey: randomUUID() } })).rejects.toThrow(/version changed/);
  });

  it("keeps an edit made outside the API and rejects the write prepared from the earlier file", async () => {
    const { companyId, skill, args, authority } = await fixture();
    const service = companySkillService(server.db);
    const outOfBand = "---\nname: release-review\ndescription: Review releases.\n---\n\n# Review\nCheck the signatures first.\n";
    await writeFile(join(String(skill.sourceLocator), "SKILL.md"), outOfBand, "utf8");

    await expect(authority.execute({ tool: "update_skill", callId: "stale-after-disk-edit",
      arguments: { ...args, idempotencyKey: randomUUID() } })).rejects.toThrow(/version changed/);
    expect((await service.readFile(companyId, skill.id, "SKILL.md"))?.content).toBe(outOfBand);
    const versions = await service.listVersions(companyId, skill.id);
    expect(versions).toHaveLength(2);
    // Version listings carry the file inventory without contents; read the version.
    expect((await service.getVersion(companyId, skill.id, versions[0].id))?.fileInventory
      .find(entry => entry.path === "SKILL.md")?.content).toBe(outOfBand);
    // The recorded version moved "currentVersionId" while the write that followed it
    // failed, so this version is the only record of the change and needs its own entry.
    expect((await server.db.select().from(activityLog).where(eq(activityLog.action, "company.skill_version_created")))
      .filter(event => event.entityId === versions[0].id))
      .toEqual([expect.objectContaining({ entityId: versions[0].id,
        details: expect.objectContaining({ skillId: skill.id, editedOutsideVersionHistory: true }) })]);

    const reconciled = await service.getById(companyId, skill.id);
    expect(reconciled?.currentVersionId).toBe(versions[0].id);
    expect(await authority.execute({ tool: "update_skill", callId: "retry-after-conflict",
      arguments: { ...args, expectedVersionId: reconciled?.currentVersionId, idempotencyKey: randomUUID() } }))
      .toMatchObject({ skillId: skill.id, path: "SKILL.md" });
    expect(await service.listVersions(companyId, skill.id)).toHaveLength(3);
  });

  it("adds no version when the files on disk match the current version", async () => {
    const { companyId, skill } = await fixture();
    const service = companySkillService(server.db);
    expect(await service.recordFileStateOutsideVersionHistory(companyId, skill.id)).toBeNull();
    expect(await service.listVersions(companyId, skill.id)).toHaveLength(1);
  });

  it("leaves the drift to a write that moved the version after the comparison", async () => {
    const { companyId, skill } = await fixture();
    const service = companySkillService(server.db);
    await writeFile(join(String(skill.sourceLocator), "SKILL.md"),
      "---\nname: release-review\ndescription: Review releases.\n---\n\n# Review\nConcurrent edit.\n", "utf8");
    // Between the unlocked comparison and the skill lock, another write records a
    // version of its own. The locked re-check has to see it and add nothing.
    const transaction = server.db.transaction.bind(server.db);
    const spy = vi.spyOn(server.db, "transaction").mockImplementationOnce((async (...args: Parameters<typeof transaction>) => {
      await service.createVersion(companyId, skill.id, { label: "Concurrent write" });
      return transaction(...args);
    }) as typeof server.db.transaction);
    try {
      expect(await service.recordFileStateOutsideVersionHistory(companyId, skill.id)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    const versions = await service.listVersions(companyId, skill.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].label).toBe("Concurrent write");
  });

  it("does not record content that a failed write rolled back before the lock", async () => {
    const { companyId, skill } = await fixture();
    const service = companySkillService(server.db);
    const skillFile = join(String(skill.sourceLocator), "SKILL.md");
    const original = await readFile(skillFile, "utf8");
    // A write through the service has put its content on disk and still holds the
    // lock; it fails and restores the file before this call gets the lock.
    await writeFile(skillFile, original.replace("# ", "# In-flight "), "utf8");
    const transaction = server.db.transaction.bind(server.db);
    const spy = vi.spyOn(server.db, "transaction").mockImplementationOnce((async (...args: Parameters<typeof transaction>) => {
      await writeFile(skillFile, original, "utf8");
      return transaction(...args);
    }) as typeof server.db.transaction);
    try {
      expect(await service.recordFileStateOutsideVersionHistory(companyId, skill.id)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(await service.listVersions(companyId, skill.id)).toHaveLength(1);
  });

  it("records files added and removed on disk, then accepts a write based on that record", async () => {
    const { companyId, skill, args, authority } = await fixture();
    const service = companySkillService(server.db);
    const skillDir = String(skill.sourceLocator);
    await mkdir(join(skillDir, "reference"), { recursive: true });
    await writeFile(join(skillDir, "reference", "checklist.md"), "# Checklist\nVerify the signatures.\n", "utf8");

    // A file set that changed on disk is what the company inventory refresh writes the
    // skill row for. Reading those files through a path that refreshes would make the
    // refresh wait for the row lock its own caller holds, so the request would hang.
    await expect(authority.execute({ tool: "update_skill", callId: "after-disk-add",
      arguments: { ...args, idempotencyKey: randomUUID() } })).rejects.toThrow(/version changed/);
    const added = await service.listVersions(companyId, skill.id);
    expect(added).toHaveLength(2);
    expect(added[0].fileInventory.map(entry => entry.path).sort()).toEqual(["SKILL.md", "reference/checklist.md"]);

    await rm(join(skillDir, "reference"), { recursive: true, force: true });
    await expect(authority.execute({ tool: "update_skill", callId: "after-disk-removal",
      arguments: { ...args, expectedVersionId: added[0].id, idempotencyKey: randomUUID() } })).rejects.toThrow(/version changed/);
    const removed = await service.listVersions(companyId, skill.id);
    expect(removed).toHaveLength(3);
    expect(removed[0].fileInventory.map(entry => entry.path)).toEqual(["SKILL.md"]);

    expect(await authority.execute({ tool: "update_skill", callId: "write-on-recorded-state",
      arguments: { ...args, expectedVersionId: removed[0].id, idempotencyKey: randomUUID() } }))
      .toMatchObject({ skillId: skill.id, path: "SKILL.md" });
  }, 45_000);

  it("denies policy changes and cross-company skill IDs", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(second.authority.execute({ tool: "update_skill", callId: "foreign", arguments: { ...first.args, idempotencyKey: randomUUID() } })).rejects.toThrow();
    await companySkillPolicyService(server.db).replace({ companyId: first.companyId, expectedRevision: 0,
      policy: { schemaVersion: 1, defaultEffect: "deny", rules: [] }, activity: { actorType: "user", actorId: "test-board" } });
    await expect(first.authority.execute({ tool: "update_skill", callId: "denied", arguments: first.args })).rejects.toThrow(/company policy/);
    expect(await companySkillService(server.db).listVersions(first.companyId, first.skill.id)).toHaveLength(1);
  });

  it("serializes simultaneous retries and checks policy again after a successful edit", async () => {
    const testFixture = await fixture();
    const calls = await Promise.all(["parallel-a", "parallel-b"].map(callId =>
      testFixture.authority.execute({ tool: "update_skill", callId, arguments: testFixture.args })));
    expect(calls[0]).toEqual(calls[1]);
    expect(await companySkillService(server.db).listVersions(testFixture.companyId, testFixture.skill.id)).toHaveLength(2);
    await companySkillPolicyService(server.db).replace({ companyId: testFixture.companyId, expectedRevision: 0,
      policy: { schemaVersion: 1, defaultEffect: "deny", rules: [] }, activity: { actorType: "user", actorId: "test-board" } });
    await expect(testFixture.authority.execute({ tool: "update_skill", callId: "revoked-retry", arguments: testFixture.args })).rejects.toThrow(/company policy/);
    expect(await companySkillService(server.db).listVersions(testFixture.companyId, testFixture.skill.id)).toHaveLength(2);
  });

  it("restores the file when the required audit callback fails", async () => {
    const testFixture = await fixture();
    const service = companySkillService(server.db);
    const original = await service.readFile(testFixture.companyId, testFixture.skill.id, "SKILL.md");
    await expect(service.updateFile(testFixture.companyId, testFixture.skill.id, "SKILL.md", testFixture.args.markdown,
      null, { expectedVersionId: testFixture.skill.currentVersionId, afterUpdate: async () => { throw new Error("audit unavailable"); } }))
      .rejects.toThrow("audit unavailable");
    expect((await service.readFile(testFixture.companyId, testFixture.skill.id, "SKILL.md"))?.content).toBe(original?.content);
    expect(await service.listVersions(testFixture.companyId, testFixture.skill.id)).toHaveLength(1);
  });

  it("rejects a competing edit with a different key and the same expected version", async () => {
    const testFixture = await fixture();
    const attempts = await Promise.allSettled([testFixture.args, { ...testFixture.args,
      idempotencyKey: randomUUID(), markdown: testFixture.args.markdown + "Another edit." }].map((argumentsValue, index) =>
      testFixture.authority.execute({ tool: "update_skill", callId: `race-${index}`, arguments: argumentsValue })));
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
    expect(await companySkillService(server.db).listVersions(testFixture.companyId, testFixture.skill.id)).toHaveLength(2);
  });

  it("hides the tool and rejects invocation in planning mode", async () => {
    const testFixture = await fixture({ mode: "planning" });
    expect(new PaperclipRunnerToolAuthority(server.db, { ...testFixture, workMode: "planning" }).definitions().some(tool => tool.name === "update_skill")).toBe(false);
    await expect(testFixture.authority.execute({ tool: "update_skill", callId: "planning", arguments: testFixture.args })).rejects.toThrow();
  });
});
