import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { activityLog, companyMemberships, heartbeatRuns, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
