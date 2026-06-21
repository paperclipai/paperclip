/**
 * Tests for resolveProjectIdForWorkspaceRecovery — the extracted project-id
 * recovery helper from heartbeat.ts.
 *
 * Covers the three required scenarios:
 *  1. issue.projectId is NULL, issue.projectWorkspaceId is set → projectId
 *     is recovered from projectWorkspaces.
 *  2. issue.projectId is set → fast-path returns it directly.
 *  3. Both are NULL → returns null (no crash).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveProjectIdForWorkspaceRecovery } from "../services/heartbeat";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-project-recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("resolveProjectIdForWorkspaceRecovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workspace-project-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: `TestCorp-${companyId.slice(0, 8)}`,
      issuePrefix: `TC${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedProjectAndWorkspace(
    companyId: string,
  ): Promise<{ projectId: string; workspaceId: string }> {
    const projectId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: `test-project-${projectId.slice(0, 8)}`,
      companyId,
    });

    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      name: `test-ws-${workspaceId.slice(0, 8)}`,
      companyId,
      projectId,
    });

    return { projectId, workspaceId };
  }

  // ── tests ──────────────────────────────────────────────────────────────────

  it("recovers projectId when issue.projectId is NULL but projectWorkspaceId is set", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const { projectId, workspaceId } = await seedProjectAndWorkspace(companyId);

    const result = await resolveProjectIdForWorkspaceRecovery({
      issueProjectId: null,
      preferredProjectWorkspaceId: workspaceId,
      contextProjectId: null,
      agentCompanyId: companyId,
      db,
    });

    expect(result).toBe(projectId);
  });

  it("returns issue.projectId directly when it is already set (fast-path)", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const existingId = randomUUID();

    const result = await resolveProjectIdForWorkspaceRecovery({
      issueProjectId: existingId,
      preferredProjectWorkspaceId: null,
      contextProjectId: null,
      agentCompanyId: companyId,
      db,
    });

    expect(result).toBe(existingId);
  });

  it("returns null when both issue.projectId and projectWorkspaceId are NULL", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);

    const result = await resolveProjectIdForWorkspaceRecovery({
      issueProjectId: null,
      preferredProjectWorkspaceId: null,
      contextProjectId: null,
      agentCompanyId: companyId,
      db,
    });

    expect(result).toBeNull();
  });

  it("returns null when projectWorkspaceId is set but the workspace row does not exist", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const fakeWorkspaceId = randomUUID();

    const result = await resolveProjectIdForWorkspaceRecovery({
      issueProjectId: null,
      preferredProjectWorkspaceId: fakeWorkspaceId,
      contextProjectId: null,
      agentCompanyId: companyId,
      db,
    });

    expect(result).toBeNull();
  });

  it("returns null when the workspace row belongs to a different company (company-scoped)", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const { projectId, workspaceId } = await seedProjectAndWorkspace(companyId);
    const otherCompanyId = randomUUID();
    await seedCompany(otherCompanyId);

    const result = await resolveProjectIdForWorkspaceRecovery({
      issueProjectId: null,
      preferredProjectWorkspaceId: workspaceId,
      contextProjectId: null,
      agentCompanyId: otherCompanyId,
      db,
    });

    // The query filters on companyId, so the workspace row won't be found.
    expect(result).toBeNull();
  });
});
