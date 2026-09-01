import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  formalQaCheckouts,
  formalQaIssuances,
  formalQaPolicies,
  formalQaPreparations,
  formalQaReviews,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { formalQaCheckoutService } from "../services/formal-qa-checkouts.js";
import { formalQaReviewService } from "../services/formal-qa-reviews.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Paperclip test",
      GIT_AUTHOR_EMAIL: "paperclip-test@example.test",
      GIT_COMMITTER_NAME: "Paperclip test",
      GIT_COMMITTER_EMAIL: "paperclip-test@example.test",
    },
    encoding: "utf8",
  }).trim();
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("Formal-QA heartbeat execution lane", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];
  const formalQaExecutor = vi.fn();
  let priorPaperclipHome: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-heartbeat-");
    db = createDb(tempDb.connectionString);
    priorPaperclipHome = process.env.PAPERCLIP_HOME;
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    if (priorPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = priorPaperclipHome;
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log", "heartbeat_run_events", "formal_qa_reviews",
        "heartbeat_runs", "agent_wakeup_requests", "workspace_runtime_services",
        "execution_workspaces", "formal_qa_checkouts", "formal_qa_issuances",
        "formal_qa_policies", "formal_qa_preparations", "issues", "environment_leases",
        "agent_runtime_state", "environments", "agents", "project_workspaces", "projects", "companies"
      RESTART IDENTITY CASCADE
    `));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(input: { expiresAt?: Date } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-heartbeat-repo-"));
    const paperclipHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-heartbeat-home-"));
    tempDirs.push(root, paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    const instanceRoot = resolvePaperclipInstanceRoot();
    const source = path.join(root, "source");
    const remote = path.join(root, "origin.git");
    await mkdir(source, { recursive: true });
    git(source, "init");
    await writeFile(path.join(source, "README.md"), "formal heartbeat sealed source\nFORMAL_QA_TEST_SECRET\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "exact source");
    git(root, "init", "--bare", remote);
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "HEAD:refs/heads/main");

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const preparationId = randomUUID();
    const policyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const headSha = git(source, "rev-parse", "HEAD");
    const treeSha = git(source, "rev-parse", "HEAD^{tree}");
    const evidenceJson = JSON.stringify({ schema: "test", headSha, treeSha });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Formal QA project", status: "in_progress" });
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Formal QA reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5", timeoutSec: 120, extraArgs: ["must-not-pass"] },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary source",
      sourceType: "local_path",
      cwd: source,
      repoUrl: "https://github.com/vivus-tech/music-tracker.git",
      isPrimary: true,
    });
    await db.insert(formalQaPolicies).values({
      id: policyId,
      companyId,
      projectId,
      projectWorkspaceId,
      reviewerAgentId,
      repository: "vivus-tech/music-tracker",
      requiredWorkflowId: "99",
      requiredCheckName: "PR Policy",
      requiredCheckAppId: 15368,
      enabled: true,
      createdByUserId: "board-user",
      updatedByUserId: "board-user",
    });
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(formalQaPreparations).values({
      id: preparationId,
      companyId,
      projectId,
      projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      prNumber: 1902,
      headSha: "0".repeat(40),
      baseRef: "pending",
      baseSha: "0".repeat(40),
      treeSha: "0".repeat(40),
      evidenceSha256: "0".repeat(64),
      issuerReceiptSha256: "0".repeat(64),
      issuerOperationId: `request:${preparationId}:v1`,
      issuedByUserId: "board-user",
      idempotencyKey: `formal-heartbeat-${preparationId}`,
      requestKey: `formal-heartbeat-${preparationId}`,
      generation: 1,
      predecessorPreparationId: null,
      requestSha256: "c".repeat(64),
      expiresAt,
      status: "prepared",
    });
    await db.update(formalQaPreparations).set({
      headSha,
      baseRef: "main",
      baseSha: headSha,
      treeSha,
      evidenceSha256: "a".repeat(64),
      issuerReceiptSha256: "a".repeat(64),
      issuerOperationId: `github-pr:vivus-tech/music-tracker#1902@${headSha}:policy:${policyId}:v1`,
      status: "issued",
      expiresAt,
      updatedAt: new Date(),
    }).where(eq(formalQaPreparations.id, preparationId));
    await db.insert(formalQaIssuances).values({
      preparationId,
      policyId,
      policyVersion: 1,
      companyId,
      projectId,
      projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      prNumber: "1902",
      headSha,
      baseRef: "main",
      baseSha: headSha,
      treeSha,
      requiredCheckName: "PR Policy",
      requiredCheckAppId: 15368,
      checkRunId: "1001",
      checkSuiteId: "2001",
      workflowRunId: "3001",
      workflowId: "99",
      evidenceJson,
      snapshotSha256: createHash("sha256").update(evidenceJson).digest("hex"),
    });

    const checkout = await formalQaCheckoutService(db, {
      instanceRoot,
      testOnlyRemoteUrl: remote,
      testOnlyAllowFileProtocol: true,
    }).materialize({ preparationId });
    const reviews = formalQaReviewService(db, {
      checkoutInstanceRoot: instanceRoot,
      checkoutTestOnlyRemoteUrl: remote,
      checkoutTestOnlyAllowFileProtocol: true,
    });
    const review = await reviews.queue({ preparationId });
    return {
      instanceRoot,
      companyId,
      projectId,
      projectWorkspaceId,
      reviewerAgentId,
      headSha,
      treeSha,
      checkout: checkout.checkout,
      review: review.review,
      reviews,
    };
  }

  it("runs a queued formal review only through the closed sandboxed lane", async () => {
    const f = await fixture();
    formalQaExecutor.mockImplementation(async (input: {
      reviewId: string;
      runId: string;
      prompt: string;
      scratchPath: string;
      sealedContent: { list: () => Promise<readonly { path: string }[]>; read: (path: string) => Promise<{ content: Buffer }> };
      onEvent?: (event: { eventType: string; stream: "stdout" | "stderr" | "system"; level: "info" | "warn" | "error"; message?: string; payload?: unknown }) => Promise<void>;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => {
      const review = f.review;
      expect(input.scratchPath).toContain("formal-qa-review-scratch");
      expect(input.prompt).toContain(`Review ID: ${review.id}`);
      expect((await input.sealedContent.list()).map((entry) => entry.path)).toContain("README.md");
      expect((await input.sealedContent.read("README.md")).content.toString("utf8")).toContain("sealed source");
      await input.onLog?.("stdout", "FORMAL_QA_TEST_SECRET");
      await input.onEvent?.({
        eventType: "item.completed", stream: "stdout", level: "info",
        message: "FORMAL_QA_TEST_SECRET",
        payload: { kind: "dynamicToolCall", content: "FORMAL_QA_TEST_SECRET" },
      });
      return {
        output: JSON.stringify({
          schema: "paperclip.formal-qa-review-decision/v1",
          reviewId: review.id,
          runId: review.heartbeatRunId,
          headSha: review.headSha,
          treeSha: review.treeSha,
          contractSha256: review.contractSha256,
          decision: "approved",
          summary: "Exact source approved.",
          findings: [],
        }),
        usage: null,
      };
    });

    const environmentsBefore = await db.select().from(environments);
    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    expect(await db.select().from(environments)).toEqual(environmentsBefore);
    await heartbeat.resumeQueuedRuns();
    const run = await waitForRunToFinish(heartbeat, f.review.heartbeatRunId);
    await heartbeat.drainActiveRunExecutions();

    expect(formalQaExecutor).toHaveBeenCalledOnce();
    const input = formalQaExecutor.mock.calls[0]![0] as { model: string | null; timeoutMs: number; prompt: string; scratchPath: string };
    const scratchPath = path.join(f.instanceRoot, "formal-qa-review-scratch", f.companyId, f.review.id);
    expect(input).toMatchObject({ model: "gpt-5", timeoutMs: 120_000, scratchPath });
    expect(input.prompt).toContain(`Run ID: ${f.review.heartbeatRunId}`);
    expect(input.prompt).toContain(`Exact head: ${f.headSha}`);

    const [review] = await db.select().from(formalQaReviews).where(eq(formalQaReviews.id, f.review.id));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId));
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(review).toMatchObject({ status: "approved", decision: "approved", terminalReason: null });
    expect(wake).toMatchObject({ status: "completed", error: null });
    expect(git(f.checkout.checkoutPath, "rev-parse", "HEAD")).toBe(f.headSha);
    expect(git(f.checkout.checkoutPath, "status", "--porcelain", "--untracked-files=all")).toBe("");
    await expect(access(scratchPath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await db.select().from(issues)).toEqual([]);
    expect(await db.select().from(workspaceRuntimeServices)).toEqual([]);
    expect(await db.select().from(environmentLeases)).toEqual([]);
    expect(await db.select().from(environments)).toEqual(environmentsBefore);
    const workspaces = await db.select().from(executionWorkspaces);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: f.review.executionWorkspaceId,
      mode: "formal_qa_checkout",
      strategyType: "formal_qa_checkout",
      cwd: expect.stringContaining("formal-qa-review-scratch"),
      branchName: null,
    });
    expect(await db.select().from(agentRuntimeState)).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents)).not.toHaveLength(0);
    const eventText = JSON.stringify(await db.select().from(heartbeatRunEvents));
    expect(eventText).not.toContain("FORMAL_QA_TEST_SECRET");
  });

  it("preserves the exact queued authority while the fleet is paused and runs it after reactivation", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerAgentId));
    formalQaExecutor.mockResolvedValue({
      output: JSON.stringify({
        schema: "paperclip.formal-qa-review-decision/v1",
        reviewId: f.review.id,
        runId: f.review.heartbeatRunId,
        headSha: f.review.headSha,
        treeSha: f.review.treeSha,
        contractSha256: f.review.contractSha256,
        decision: "approved",
        summary: "Approved after fleet reactivation.",
        findings: [],
      }), usage: null,
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(formalQaExecutor).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "queued" });
    expect(await formalQaReviewService(db).getById(f.review.id)).toMatchObject({ status: "queued" });

    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.reviewerAgentId));
    await heartbeat.resumeQueuedRuns();
    const run = await waitForRunToFinish(heartbeat, f.review.heartbeatRunId);
    await heartbeat.drainActiveRunExecutions();
    expect(formalQaExecutor).toHaveBeenCalledOnce();
    expect(run).toMatchObject({ status: "succeeded" });
    expect(await formalQaReviewService(db).getById(f.review.id)).toMatchObject({ status: "approved" });
  });

  it("requeues the same sealed run once after a crash and removes stale scratch state", async () => {
    const f = await fixture();
    const claimed = await f.reviews.claimRun({
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    });
    await writeFile(path.join(claimed.scratchPath, "stale-from-lost-process"), "must not survive\n");
    await db.update(heartbeatRuns).set({
      status: "running",
      startedAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
      processLossRetryCount: 0,
    }).where(eq(heartbeatRuns.id, f.review.heartbeatRunId));
    await db.update(agentWakeupRequests).set({ status: "running", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, f.review.wakeupRequestId));
    formalQaExecutor.mockResolvedValue({
      output: JSON.stringify({
        schema: "paperclip.formal-qa-review-decision/v1",
        reviewId: f.review.id,
        runId: f.review.heartbeatRunId,
        headSha: f.review.headSha,
        treeSha: f.review.treeSha,
        contractSha256: f.review.contractSha256,
        decision: "approved",
        summary: "Recovered exact review.",
        findings: [],
      }), usage: null,
    });

    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    const run = await waitForRunToFinish(heartbeat, f.review.heartbeatRunId);
    await heartbeat.drainActiveRunExecutions();
    expect(reaped).toEqual({ reaped: 1, runIds: [f.review.heartbeatRunId] });
    expect(formalQaExecutor).toHaveBeenCalledOnce();
    expect(run).toMatchObject({ status: "succeeded", processLossRetryCount: 1 });
    expect(await f.reviews.getById(f.review.id)).toMatchObject({ status: "approved" });
    await expect(access(path.join(claimed.scratchPath, "stale-from-lost-process")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails the sealed review closed when the single crash retry is exhausted", async () => {
    const f = await fixture();
    const claimed = await f.reviews.claimRun({
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    });
    await writeFile(path.join(claimed.scratchPath, "stale-terminal"), "remove me\n");
    await db.update(heartbeatRuns).set({
      status: "running",
      startedAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
      processLossRetryCount: 1,
    }).where(eq(heartbeatRuns.id, f.review.heartbeatRunId));
    await db.update(agentWakeupRequests).set({ status: "running", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, f.review.wakeupRequestId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(reaped).toEqual({ reaped: 1, runIds: [f.review.heartbeatRunId] });
    expect(formalQaExecutor).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({
      status: "failed",
      errorCode: "formal_qa_process_lost",
    });
    expect(await f.reviews.getById(f.review.id)).toMatchObject({
      status: "failed",
      decision: null,
      terminalReason: "Formal-QA reviewer process was lost after its bounded retry",
    });
    await expect(access(claimed.scratchPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically cancels the bound review on agent pause and aborts the live Formal-QA executor", async () => {
    const f = await fixture();
    let observedAbort = false;
    formalQaExecutor.mockImplementation(async (input: { signal?: AbortSignal }) => new Promise((_, reject) => {
      const abort = () => {
        observedAbort = true;
        reject(new Error("formal_qa_codex_cancelled"));
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    }));

    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    await heartbeat.resumeQueuedRuns();
    const deadline = Date.now() + 5_000;
    while (formalQaExecutor.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(formalQaExecutor).toHaveBeenCalledOnce();

    expect(await heartbeat.cancelActiveForAgent(f.reviewerAgentId, "Cancelled due to agent pause")).toBe(1);
    await heartbeat.drainActiveRunExecutions();

    expect(observedAbort).toBe(true);
    expect(await f.reviews.getById(f.review.id)).toMatchObject({
      status: "cancelled",
      decision: null,
      terminalReason: "Cancelled due to agent pause",
    });
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "cancelled" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId)))
      .toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.review.executionWorkspaceId)))
      .toEqual([expect.objectContaining({ status: "archived", cleanupReason: "formal_qa_terminal:cancelled" })]);
    await expect(access(path.join(f.instanceRoot, "formal-qa-review-scratch", f.companyId, f.review.id)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start the provider when cancellation commits after the claim", async () => {
    const f = await fixture();
    let heartbeat!: ReturnType<typeof heartbeatService>;
    let crossedClaimBarrier = false;
    heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      formalQaExecutor,
      afterFormalQaRunClaim: async ({ runId, reviewId }) => {
        crossedClaimBarrier = true;
        expect(runId).toBe(f.review.heartbeatRunId);
        expect(reviewId).toBe(f.review.id);
        expect(await heartbeat.cancelActiveForAgent(
          f.reviewerAgentId,
          "Cancelled at the committed Formal-QA claim barrier",
        )).toBe(1);
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(crossedClaimBarrier).toBe(true);
    expect(formalQaExecutor).not.toHaveBeenCalled();
    expect(await f.reviews.getById(f.review.id)).toMatchObject({
      status: "cancelled",
      decision: null,
      terminalReason: "Cancelled at the committed Formal-QA claim barrier",
    });
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "cancelled" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId)))
      .toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("cancels a generic scheduled-retry run with its still-live wakeup", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({
      status: "scheduled_retry",
      contextSnapshot: {},
    }).where(eq(heartbeatRuns.id, f.review.heartbeatRunId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    expect(await heartbeat.cancelRun(f.review.heartbeatRunId, "Cancelled scheduled retry"))
      .toMatchObject({ status: "cancelled", error: "Cancelled scheduled retry" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId)))
      .toEqual([expect.objectContaining({ status: "cancelled", error: "Cancelled scheduled retry" })]);
    expect(formalQaExecutor).not.toHaveBeenCalled();
  });

  it("preserves a sealed decision that commits before cancellation takes the review lock", async () => {
    const f = await fixture();
    let resolveProvider!: (value: { output: string; usage: null }) => void;
    const providerStarted = new Promise<void>((resolve) => {
      formalQaExecutor.mockImplementation(() => {
        resolve();
        return new Promise((providerResolve) => { resolveProvider = providerResolve; });
      });
    });
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    let cancellationPaused!: () => void;
    const cancellationReachedBarrier = new Promise<void>((resolve) => { cancellationPaused = resolve; });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      formalQaExecutor,
      beforeFormalQaRunCancellation: async ({ runId, reviewId }) => {
        expect(runId).toBe(f.review.heartbeatRunId);
        expect(reviewId).toBe(f.review.id);
        cancellationPaused();
        await cancellationGate;
      },
    });

    await heartbeat.resumeQueuedRuns();
    await providerStarted;
    const cancellation = heartbeat.cancelRun(f.review.heartbeatRunId, "Stale cancellation must not replace approval");
    await cancellationReachedBarrier;
    const output = JSON.stringify({
      schema: "paperclip.formal-qa-review-decision/v1",
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      headSha: f.review.headSha,
      treeSha: f.review.treeSha,
      contractSha256: f.review.contractSha256,
      decision: "approved",
      summary: "Approval won the terminal review lock.",
      findings: [],
    });
    expect(await f.reviews.finishRun({
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output,
    })).toMatchObject({ status: "approved", decision: "approved" });
    releaseCancellation();
    await cancellation;
    resolveProvider({ output, usage: null });
    await heartbeat.drainActiveRunExecutions();

    expect(await f.reviews.getById(f.review.id)).toMatchObject({ status: "approved", decision: "approved" });
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "succeeded", error: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId)))
      .toEqual([expect.objectContaining({ status: "completed", error: null })]);
  });

  it("reaper preserves a committed approval and converges stale run, wakeup, and workspace rows", async () => {
    const f = await fixture();
    await f.reviews.claimRun({
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    });
    const artifact = JSON.stringify({
      schema: "paperclip.formal-qa-review-decision/v1",
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      headSha: f.review.headSha,
      treeSha: f.review.treeSha,
      contractSha256: f.review.contractSha256,
      decision: "approved",
      summary: "Approval committed before scheduler projection.",
      findings: [],
    });
    await f.reviews.finishRun({
      reviewId: f.review.id,
      runId: f.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output: artifact,
    });
    const stale = new Date(Date.now() - 60_000);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, updatedAt: stale })
      .where(eq(heartbeatRuns.id, f.review.heartbeatRunId));
    await db.update(agentWakeupRequests).set({ status: "running", finishedAt: null, updatedAt: stale })
      .where(eq(agentWakeupRequests.id, f.review.wakeupRequestId));
    await db.update(executionWorkspaces).set({ status: "active", closedAt: null, cleanupReason: null, updatedAt: stale })
      .where(eq(executionWorkspaces.id, f.review.executionWorkspaceId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    expect(await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 }))
      .toEqual({ reaped: 1, runIds: [f.review.heartbeatRunId] });
    expect(await f.reviews.getById(f.review.id)).toMatchObject({ status: "approved", decision: "approved" });
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "succeeded", error: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId)))
      .toEqual([expect.objectContaining({ status: "completed", error: null })]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.review.executionWorkspaceId)))
      .toEqual([expect.objectContaining({ status: "archived", cleanupReason: "formal_qa_terminal:approved" })]);
  });

  it("expires queued Formal-QA authority while the reviewer fleet is paused", async () => {
    const f = await fixture({ expiresAt: new Date(Date.now() + 1_500) });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerAgentId));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, f.review.expiresAt.getTime() - Date.now() + 20)));
    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    expect(await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).toEqual({ reaped: 0, runIds: [] });
    expect(formalQaExecutor).not.toHaveBeenCalled();
    expect(await f.reviews.getById(f.review.id)).toMatchObject({ status: "expired", decision: null });
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "failed", errorCode: "formal_qa_review_expired" });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.review.wakeupRequestId)))
      .toEqual([expect.objectContaining({ status: "failed" })]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.review.executionWorkspaceId)))
      .toEqual([expect.objectContaining({ status: "archived", cleanupReason: "formal_qa_terminal:expired" })]);
  });

  it("expiry aborts a running Formal-QA executor and late completion cannot replace expiry", async () => {
    const f = await fixture({ expiresAt: new Date(Date.now() + 1_500) });
    let observedAbort = false;
    formalQaExecutor.mockImplementation(async (input: { signal?: AbortSignal }) => new Promise((_, reject) => {
      const abort = () => { observedAbort = true; reject(new Error("formal_qa_review_expired")); };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    }));
    const heartbeat = heartbeatService(db, { runtimeEnv: {}, formalQaExecutor });
    await heartbeat.resumeQueuedRuns();
    const startedDeadline = Date.now() + 5_000;
    while (formalQaExecutor.mock.calls.length === 0 && Date.now() < startedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(formalQaExecutor).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, f.review.expiresAt.getTime() - Date.now() + 20)));
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 60_000 });
    await heartbeat.drainActiveRunExecutions();
    expect(observedAbort).toBe(true);
    expect(await f.reviews.getById(f.review.id)).toMatchObject({ status: "expired", decision: null });
    expect(await heartbeat.getRun(f.review.heartbeatRunId)).toMatchObject({ status: "failed", errorCode: "formal_qa_review_expired" });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.review.executionWorkspaceId)))
      .toEqual([expect.objectContaining({ status: "archived", cleanupReason: "formal_qa_terminal:expired" })]);
  });
});
