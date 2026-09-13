import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";

describe("native workspace finalization recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let workspaceRoot: string;
  let priorLogRoot: string | undefined;

  const companyId = randomUUID();
  const foreignCompanyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const foreignProjectId = randomUUID();

  async function seedRun(input: {
    executionWorkspaceId: string;
    title: string;
  }) {
    const issueId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const resultId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: input.title,
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "native-workspace-finalizer-test-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: input.title },
      canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: issueId,
      completionContractId: contractId,
      runnerProfileJson: {
        nativeExecutionInput: {
          binding: { executionWorkspaceId: input.executionWorkspaceId },
        },
      },
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `result-${resultId}`,
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: `result-${resultId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      companyId,
      issueId,
      runId,
      phase: "result_accepted",
      resultId,
    });
    return { issueId, runId };
  }

  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-native-workspace-finalizer-"),
    );
    priorLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(
      workspaceRoot,
      "operation-logs",
    );
    temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-native-workspace-finalizer-",
    );
    db = createDb(temporary.connectionString);

    await db.insert(companies).values([
      { id: companyId, name: "Native workspace owner", issuePrefix: "NWO" },
      {
        id: foreignCompanyId,
        name: "Foreign workspace owner",
        issuePrefix: "FWX",
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native workspace agent",
      adapterType: "paperclip_runner",
      status: "running",
    });
    await db.insert(projects).values([
      {
        id: projectId,
        companyId,
        name: "Native workspace project",
        status: "active",
      },
      {
        id: foreignProjectId,
        companyId: foreignCompanyId,
        name: "Foreign workspace project",
        status: "active",
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await temporary.cleanup();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (priorLogRoot === undefined) {
      delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    } else {
      process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogRoot;
    }
  });

  it("records directory-only recovery without inventing an execution-workspace foreign key", async () => {
    const cwd = path.join(workspaceRoot, "directory-only");
    await fs.mkdir(cwd);
    const seeded = await seedRun({
      executionWorkspaceId: randomUUID(),
      title: "Recover a directory-only workspace",
    });

    // Use the run id as the directory-only containment token, matching the native binding
    // that exposed the production FK failure.
    await db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: {
          nativeExecutionInput: {
            binding: { executionWorkspaceId: seeded.runId },
          },
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      phase: "workspace_finalize",
      cwd,
      status: "failed",
    });

    const operation = await resumeNativeWorkspaceFinalization({
      db,
      runId: seeded.runId,
    });

    expect(operation).toMatchObject({
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      executionWorkspaceId: null,
      cwd,
      status: "succeeded",
    });
    expect(operation.metadata).toMatchObject({
      owningService: "native_workspace_finalizer",
      observation: "workspace_directory",
    });
  });

  it("retains a real company-owned execution workspace on the resumed operation", async () => {
    const cwd = path.join(workspaceRoot, "owned-workspace");
    await fs.mkdir(cwd);
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "local",
      strategyType: "local_directory",
      name: "Owned workspace",
      cwd,
    });
    const seeded = await seedRun({
      executionWorkspaceId,
      title: "Recover an owned execution workspace",
    });

    const operation = await resumeNativeWorkspaceFinalization({
      db,
      runId: seeded.runId,
    });

    expect(operation).toMatchObject({
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      executionWorkspaceId,
      cwd,
      status: "succeeded",
    });
  });

  it("does not attach a foreign-company workspace while retaining the bound prior operation cwd", async () => {
    const authorizedCwd = path.join(
      workspaceRoot,
      "authorized-prior-operation",
    );
    const foreignCwd = path.join(workspaceRoot, "foreign-workspace");
    const mismatchedCwd = path.join(
      workspaceRoot,
      "mismatched-issue-operation",
    );
    await Promise.all([
      fs.mkdir(authorizedCwd),
      fs.mkdir(foreignCwd),
      fs.mkdir(mismatchedCwd),
    ]);
    const foreignWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: foreignWorkspaceId,
      companyId: foreignCompanyId,
      projectId: foreignProjectId,
      mode: "local",
      strategyType: "local_directory",
      name: "Foreign workspace",
      cwd: foreignCwd,
    });
    const seeded = await seedRun({
      executionWorkspaceId: foreignWorkspaceId,
      title: "Reject a foreign execution workspace",
    });
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      phase: "workspace_finalize",
      cwd: authorizedCwd,
      status: "failed",
    });
    const mismatchedIssueId = randomUUID();
    await db.insert(issues).values({
      id: mismatchedIssueId,
      companyId,
      title: "Unrelated workspace operation",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: seeded.runId,
      issueId: mismatchedIssueId,
      phase: "workspace_finalize",
      cwd: mismatchedCwd,
      status: "failed",
      createdAt: new Date(Date.now() + 1_000),
    });

    const operation = await resumeNativeWorkspaceFinalization({
      db,
      runId: seeded.runId,
    });

    expect(operation).toMatchObject({
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      executionWorkspaceId: null,
      cwd: authorizedCwd,
      status: "succeeded",
    });
    expect(operation.cwd).not.toBe(foreignCwd);
    expect(operation.cwd).not.toBe(mismatchedCwd);

    const persisted = await db
      .select()
      .from(workspaceOperations)
      .where(
        and(
          eq(workspaceOperations.id, operation.id),
          eq(workspaceOperations.companyId, companyId),
          eq(workspaceOperations.issueId, seeded.issueId),
        ),
      )
      .orderBy(desc(workspaceOperations.createdAt))
      .limit(1);
    expect(persisted).toEqual([
      expect.objectContaining({
        executionWorkspaceId: null,
        cwd: authorizedCwd,
      }),
    ]);
  });
});
