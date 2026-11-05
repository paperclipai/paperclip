import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { recordDeliveryAttestation } from "../services/delivery-attestations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("workspace_delivery terminal transition gate", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-delivery-attestations-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(repoUrl: string | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery fixture", issuePrefix: `D${companyId.slice(0, 6)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "Delivery project" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id, name: "primary", repoUrl }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Runner" }).returning();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Delivery fixture issue",
      projectWorkspaceId: workspace.id,
      completionRequirement: "workspace_delivery",
    });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, issueId }).returning();
    return { companyId, issueId, projectId: project.id, workspaceId: workspace.id, runId: run.id, agentId: agent.id };
  }

  it("blocks done without any attestation", async () => {
    const { issueId, companyId } = await fixture("https://example.com/org/repo.git");
    const service = issueService(db);
    await expect(service.update(issueId, { status: "done", companyGuard: companyId })).rejects.toThrow(
      /delivery attestation is required/i,
    );
  });

  it("blocks done when the workspace has no repository locator", async () => {
    const { issueId, companyId, runId } = await fixture(null);
    await expect(
      recordDeliveryAttestation(db, { companyId, runId, outcome: "succeeded" }),
    ).rejects.toThrow(/no repository-backed delivery target/i);
    const service = issueService(db);
    await expect(service.update(issueId, { status: "done", companyGuard: companyId })).rejects.toThrow(
      /repository-backed delivery target/i,
    );
  });

  it("allows done once the run recorded a matching succeeded attestation", async () => {
    const { issueId, companyId, runId } = await fixture("https://example.com/org/repo.git");
    await recordDeliveryAttestation(db, { companyId, runId, outcome: "succeeded", deliveredRevision: "abc123" });
    const service = issueService(db);
    const updated = await service.update(issueId, { status: "done", companyGuard: companyId });
    expect(updated?.status).toBe("done");
  });

  it("gates on the workspace the update saves, not the one it replaces", async () => {
    const { issueId, companyId, runId, projectId } = await fixture("https://example.com/org/repo.git");
    // The run delivered the issue's current workspace, so that attestation is valid there.
    await recordDeliveryAttestation(db, { companyId, runId, outcome: "succeeded" });
    const settings = instanceSettingsService(db);
    const previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      const [otherSource] = await db.insert(projectWorkspaces).values({
        companyId, projectId, name: "other", repoUrl: "https://example.com/org/other-repo.git",
      }).returning();
      const [otherExecution] = await db.insert(executionWorkspaces).values({
        companyId, projectId, projectWorkspaceId: otherSource.id,
        mode: "shared_workspace", strategyType: "project_primary", name: "other",
      }).returning();
      const service = issueService(db);
      await expect(service.update(issueId, {
        status: "done",
        executionWorkspaceId: otherExecution.id,
        companyGuard: companyId,
      })).rejects.toThrow(/delivery attestation is required/i);
      const stored = await db.select({ projectWorkspaceId: issues.projectWorkspaceId }).from(issues).where(eq(issues.id, issueId));
      expect(stored[0]?.projectWorkspaceId).not.toBe(otherSource.id);
    } finally {
      await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces });
    }
  });

  it("does not let a stale attestation satisfy a reconfigured workspace", async () => {
    const { issueId, companyId, runId, workspaceId } = await fixture("https://example.com/org/repo.git");
    await recordDeliveryAttestation(db, { companyId, runId, outcome: "succeeded" });
    await db.update(projectWorkspaces).set({ repoUrl: "https://example.com/org/other-repo.git" }).where(
      eq(projectWorkspaces.id, workspaceId),
    );
    const service = issueService(db);
    await expect(service.update(issueId, { status: "done", companyGuard: companyId })).rejects.toThrow(
      /delivery attestation is required/i,
    );
  });

  it("does not let an agent clear the requirement to slip past the gate", async () => {
    const { issueId, companyId, agentId } = await fixture("https://example.com/org/repo.git");
    const service = issueService(db);
    await expect(
      service.update(issueId, {
        status: "done",
        completionRequirement: null,
        companyGuard: companyId,
        actorAgentId: agentId,
      }),
    ).rejects.toThrow(/only a human may change the completion requirement/i);
  });

  it("does not gate issues with no completion requirement (today's default)", async () => {
    const { issueId, companyId } = await fixture("https://example.com/org/repo.git");
    const service = issueService(db);
    await service.update(issueId, { completionRequirement: null, companyGuard: companyId });
    const updated = await service.update(issueId, { status: "done", companyGuard: companyId });
    expect(updated?.status).toBe("done");
  });

  it("rejects recording a second attestation for the same run", async () => {
    const { companyId, runId } = await fixture("https://example.com/org/repo.git");
    await recordDeliveryAttestation(db, { companyId, runId, outcome: "succeeded" });
    await expect(recordDeliveryAttestation(db, { companyId, runId, outcome: "succeeded" })).rejects.toThrow(
      /already recorded/i,
    );
  });
});
