import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  formalQaCheckouts,
  formalQaIssuances,
  formalQaPolicies,
  formalQaPreparations,
  formalQaReviews,
  heartbeatRuns,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import {
  FORMAL_QA_REVIEW_CONTRACT_SHA256,
  formalQaReviewService,
} from "../services/formal-qa-reviews.js";
import { formalQaCheckoutService } from "../services/formal-qa-checkouts.js";

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

function postgresMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; cause?: { message?: unknown } };
    return [value.message, value.cause?.message]
      .filter((item): item is string => typeof item === "string")
      .join("\n");
  }
  return String(error);
}

describeEmbeddedPostgres("Formal-QA review lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-reviews-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(formalQaReviews);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(executionWorkspaces);
    await db.delete(formalQaCheckouts);
    await db.delete(formalQaIssuances);
    await db.delete(formalQaPolicies);
    await db.delete(formalQaPreparations);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-review-repo-"));
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-review-home-"));
    const source = path.join(root, "source");
    const remote = path.join(root, "origin.git");
    tempDirs.push(root, instanceRoot);
    await mkdir(source, { recursive: true });
    git(source, "init");
    await writeFile(path.join(source, "README.md"), "sealed formal QA source\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "sealed source");
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
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Formal QA project", status: "in_progress" });
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Formal QA reviewer",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5" },
      runtimeConfig: { profile: "formal-review" },
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
    await db.insert(formalQaPreparations).values({
      id: preparationId,
      companyId,
      projectId,
      projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      prNumber: 1902,
      headSha,
      baseRef: "main",
      baseSha: headSha,
      treeSha,
      evidenceSha256: "a".repeat(64),
      issuerReceiptSha256: "b".repeat(64),
      issuerOperationId: "test-formal-qa-issuance",
      issuedByUserId: "board-user",
      idempotencyKey: `formal-review-${preparationId}`,
      requestSha256: "c".repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "issued",
    });
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

    const checkoutService = formalQaCheckoutService(db, {
      instanceRoot,
      testOnlyRemoteUrl: remote,
      testOnlyAllowFileProtocol: true,
    });
    const checkout = await checkoutService.materialize({ preparationId });
    const reviews = formalQaReviewService(db, {
      checkoutInstanceRoot: instanceRoot,
      checkoutTestOnlyRemoteUrl: remote,
      checkoutTestOnlyAllowFileProtocol: true,
    });
    return {
      root,
      source,
      remote,
      instanceRoot,
      companyId,
      projectId,
      projectWorkspaceId,
      preparationId,
      policyId,
      reviewerAgentId,
      headSha,
      treeSha,
      checkout: checkout.checkout,
      reviews,
    };
  }

  function decision(review: typeof formalQaReviews.$inferSelect, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      schema: "paperclip.formal-qa-review-decision/v1",
      reviewId: review.id,
      runId: review.heartbeatRunId,
      headSha: review.headSha,
      treeSha: review.treeSha,
      contractSha256: review.contractSha256,
      decision: "approved",
      summary: "The exact sealed source passed the bounded review.",
      findings: [],
      ...overrides,
    });
  }

  it("queues one durable review under concurrent replay and binds only exact server-owned context", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      f.reviews.queue({ preparationId: f.preparationId }),
      f.reviews.queue({ preparationId: f.preparationId }),
    ]);

    expect(first.review.id).toBe(second.review.id);
    expect([first.replayed, second.replayed].filter((value) => value === false)).toHaveLength(1);
    const review = first.review;
    const [workspace] = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, review.executionWorkspaceId));
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, review.wakeupRequestId));
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, review.heartbeatRunId));

    expect(await db.select().from(formalQaReviews)).toHaveLength(1);
    expect(workspace).toMatchObject({
      companyId: f.companyId,
      projectId: f.projectId,
      projectWorkspaceId: f.projectWorkspaceId,
      sourceIssueId: null,
      mode: "formal_qa_checkout",
      strategyType: "formal_qa_checkout",
      cwd: expect.stringContaining("formal-qa-review-scratch"),
      providerRef: expect.stringContaining("formal-qa-review-scratch"),
      baseRef: f.headSha,
      branchName: null,
    });
    expect(workspace?.metadata).toMatchObject({
      reviewId: review.id,
      preparationId: f.preparationId,
      checkoutId: f.checkout.id,
      checkoutSha256: f.checkout.checkoutSha256,
      contractSha256: FORMAL_QA_REVIEW_CONTRACT_SHA256,
      promptSha256: review.promptSha256,
      sourceSnapshotSha256: review.sourceSnapshotSha256,
    });
    expect(JSON.parse(review.sourceSnapshotJson)).toEqual({
      schema: "paperclip.formal-qa-review-source/v1",
      preparationId: f.preparationId,
      issuanceId: expect.any(String),
      checkoutId: f.checkout.id,
      policyId: f.policyId,
      policyVersion: 1,
      reviewerAgentId: f.reviewerAgentId,
      repository: "vivus-tech/music-tracker",
      prNumber: 1902,
      headSha: f.headSha,
      baseRef: "main",
      baseSha: f.headSha,
      treeSha: f.treeSha,
      checkoutPath: f.checkout.checkoutPath,
      issuanceSha256: expect.any(String),
      checkoutSha256: f.checkout.checkoutSha256,
      contractSha256: FORMAL_QA_REVIEW_CONTRACT_SHA256,
      reviewerConfigSha256: review.reviewerConfigSha256,
      sourceManifestSha256: review.sourceManifestSha256,
    });
    expect(review.sourceSnapshotSha256).toBe(createHash("sha256").update(review.sourceSnapshotJson).digest("hex"));
    expect(JSON.parse(review.sourceManifestJson)).toMatchObject({
      schema: "paperclip.formal-qa-source-manifest/v1",
      headSha: f.headSha,
      treeSha: f.treeSha,
      entries: [expect.objectContaining({ path: "README.md", mode: "100644", sha256: expect.any(String), size: 24 })],
    });
    expect(wake).toMatchObject({
      agentId: f.reviewerAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "formal_qa_review",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "formal_qa_review_controller",
      runId: review.heartbeatRunId,
      payload: { schema: "paperclip.formal-qa-review-context/v1", formalQaReviewId: review.id },
    });
    expect(run).toMatchObject({
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      status: "queued",
      runtimeMode: "legacy",
      runtimeModeResolverVersion: "formal-qa/v1",
      runtimeModeReason: "formal_qa_review",
      wakeupRequestId: review.wakeupRequestId,
      contextSnapshot: { schema: "paperclip.formal-qa-review-context/v1", formalQaReviewId: review.id },
    });
  });

  it("rejects wrong review/run/agent/company bindings before claim", async () => {
    const f = await fixture();
    const { review } = await f.reviews.queue({ preparationId: f.preparationId });
    for (const input of [
      { reviewId: randomUUID(), runId: review.heartbeatRunId, companyId: f.companyId, agentId: f.reviewerAgentId },
      { reviewId: review.id, runId: randomUUID(), companyId: f.companyId, agentId: f.reviewerAgentId },
      { reviewId: review.id, runId: review.heartbeatRunId, companyId: randomUUID(), agentId: f.reviewerAgentId },
      { reviewId: review.id, runId: review.heartbeatRunId, companyId: f.companyId, agentId: randomUUID() },
    ]) {
      await expect(f.reviews.loadRunBinding(input)).rejects.toMatchObject<HttpError>({
        status: 409,
        details: { code: "formal_qa_review_run_mismatch" },
      });
    }
  });

  it("fails claim closed on reviewer-config or policy drift, without changing the queued review", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    await db.update(agents).set({ adapterConfig: { model: "changed-after-queue" } })
      .where(eq(agents.id, f.reviewerAgentId));
    await expect(f.reviews.claimRun({
      reviewId: queued.review.id,
      runId: queued.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_review_authority_changed" } });
    expect((await f.reviews.loadRunBinding({ reviewId: queued.review.id, runId: queued.review.heartbeatRunId, companyId: f.companyId, agentId: f.reviewerAgentId })).status).toBe("queued");

    const g = await fixture();
    const other = await g.reviews.queue({ preparationId: g.preparationId });
    await db.update(formalQaPolicies).set({
      enabled: false,
      version: 2,
      updatedByUserId: "board-user",
      updatedAt: new Date(),
    }).where(eq(formalQaPolicies.id, g.policyId));
    await expect(g.reviews.claimRun({ reviewId: other.review.id, runId: other.review.heartbeatRunId, companyId: g.companyId, agentId: g.reviewerAgentId }))
      .rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_checkout_policy_revoked" } });
  });

  it("never reuses a sealed review for a transient retry after expiry or policy revocation", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    await f.reviews.claimRun({ reviewId: queued.review.id, runId: queued.review.heartbeatRunId, companyId: f.companyId, agentId: f.reviewerAgentId });

    await db.update(formalQaPolicies).set({
      enabled: false,
      version: 2,
      updatedByUserId: "board-user",
      updatedAt: new Date(),
    }).where(eq(formalQaPolicies.id, f.policyId));
    await expect(f.reviews.verifyRetryAuthority({
      reviewId: queued.review.id,
      runId: queued.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_checkout_policy_revoked" } });
  });

  it("accepts one exact terminal decision and makes the terminal write replay-safe", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    const claim = await f.reviews.claimRun({
      reviewId: queued.review.id,
      runId: queued.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    });
    expect(claim.review.status).toBe("running");
    expect(claim.prompt).toContain(`Review ID: ${claim.review.id}`);
    expect(claim.prompt).toContain(`Exact head: ${f.headSha}`);

    const approved = await f.reviews.finishRun({
      reviewId: claim.review.id,
      runId: claim.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output: decision(claim.review),
    });
    const replayed = await f.reviews.finishRun({
      reviewId: claim.review.id,
      runId: claim.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output: decision(claim.review, { decision: "rejected", summary: "spoofed retry" }),
    });
    expect(approved).toMatchObject({ status: "approved", decision: "approved", terminalReason: null });
    expect(replayed).toMatchObject({ id: approved.id, status: "approved", decision: "approved" });
    expect(approved.decisionSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists only redacted reviewer prose and findings without changing the sealed decision binding", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    const claim = await f.reviews.claimRun({ reviewId: queued.review.id, runId: queued.review.heartbeatRunId, companyId: f.companyId, agentId: f.reviewerAgentId });
    const secret = "ghp_formal_qa_should_not_persist";
    const finished = await f.reviews.finishRun({
      reviewId: claim.review.id,
      runId: claim.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output: decision(claim.review, {
        summary: `Authorization: Bearer ${secret}`,
        findings: [{ severity: "high", title: `Credential ${secret}`, body: `token=${secret}`, path: "README.md", line: 1 }],
      }),
    });
    const persisted = JSON.stringify(finished.decisionArtifact);
    expect(finished).toMatchObject({ status: "approved", decision: "approved" });
    expect(persisted).not.toContain(secret);
    expect(finished.decisionArtifact).toMatchObject({
      reviewId: claim.review.id,
      runId: claim.review.heartbeatRunId,
      headSha: f.headSha,
      treeSha: f.treeSha,
      contractSha256: claim.review.contractSha256,
      summary: expect.stringContaining("***REDACTED***"),
    });
  });

  it("reads only sealed Git blobs and fails closed if the mutable checkout changes", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    await f.reviews.claimRun({
      reviewId: queued.review.id,
      runId: queued.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
    });
    const source = await f.reviews.readSourceFile({
      reviewId: queued.review.id,
      runId: queued.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      path: "README.md",
    });
    expect(source.content.toString("utf8")).toBe("sealed formal QA source\n");
    await writeFile(path.join(f.checkout.checkoutPath, "README.md"), "mutated after queue\n");
    await expect(f.reviews.readSourceFile({
      reviewId: queued.review.id,
      runId: queued.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      path: "README.md",
    })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_checkout_verification_failed" } });
  });

  it("rejects malformed or spoofed terminal artifacts and taints a changed checkout", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    const claim = await f.reviews.claimRun({ reviewId: queued.review.id, runId: queued.review.heartbeatRunId, companyId: f.companyId, agentId: f.reviewerAgentId });
    const malformed = await f.reviews.finishRun({
      reviewId: claim.review.id,
      runId: claim.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output: decision(claim.review, { runId: randomUUID() }),
    });
    expect(malformed).toMatchObject({ status: "failed", decision: null, decisionArtifact: null });

    const g = await fixture();
    const second = await g.reviews.queue({ preparationId: g.preparationId });
    const secondClaim = await g.reviews.claimRun({ reviewId: second.review.id, runId: second.review.heartbeatRunId, companyId: g.companyId, agentId: g.reviewerAgentId });
    await writeFile(path.join(g.checkout.checkoutPath, "untracked-tamper.txt"), "tampered\n");
    const tainted = await g.reviews.finishRun({
      reviewId: secondClaim.review.id,
      runId: secondClaim.review.heartbeatRunId,
      companyId: g.companyId,
      agentId: g.reviewerAgentId,
      succeeded: true,
      output: decision(secondClaim.review),
    });
    expect(tainted).toMatchObject({ status: "tainted", decision: null, decisionArtifact: null });
  });

  it("database triggers reject direct prompt/status and spoofed-terminal SQL writes", async () => {
    const f = await fixture();
    const queued = await f.reviews.queue({ preparationId: f.preparationId });
    await expect(db.execute(sql`
      UPDATE formal_qa_reviews
      SET prompt_sha256 = ${"f".repeat(64)}
      WHERE id = ${queued.review.id}::uuid
    `)).rejects.toSatisfy((error: unknown) => postgresMessage(error).includes("formal_qa_review_authority_immutable"));
    await expect(db.execute(sql`
      UPDATE formal_qa_reviews
      SET source_snapshot_json = ${"{}"}
      WHERE id = ${queued.review.id}::uuid
    `)).rejects.toSatisfy((error: unknown) => postgresMessage(error).includes("formal_qa_review_authority_immutable"));

    await expect(db.execute(sql`
      UPDATE formal_qa_reviews
      SET status = 'approved'
      WHERE id = ${queued.review.id}::uuid
    `)).rejects.toSatisfy((error: unknown) => postgresMessage(error).includes("formal_qa_review_transition_invalid"));

    const claim = await f.reviews.claimRun({ reviewId: queued.review.id, runId: queued.review.heartbeatRunId, companyId: f.companyId, agentId: f.reviewerAgentId });
    const structurallyValid = decision(claim.review);
    await expect(db.execute(sql`
      UPDATE formal_qa_reviews
      SET status = 'approved',
          decision = 'approved',
          decision_artifact = ${structurallyValid}::jsonb,
          decision_sha256 = ${"e".repeat(64)},
          finished_at = now()
      WHERE id = ${claim.review.id}::uuid
    `)).rejects.toSatisfy((error: unknown) => postgresMessage(error).includes("formal_qa_review_decision_invalid"));

    await db.update(formalQaPolicies).set({
      enabled: false,
      version: 2,
      updatedByUserId: "board-user",
      updatedAt: new Date(),
    }).where(eq(formalQaPolicies.id, f.policyId));
    await expect(f.reviews.finishRun({
      reviewId: claim.review.id,
      runId: claim.review.heartbeatRunId,
      companyId: f.companyId,
      agentId: f.reviewerAgentId,
      succeeded: true,
      output: structurallyValid,
    })).resolves.toMatchObject({
      status: "failed",
      decision: null,
      decisionArtifact: null,
      terminalReason: "Formal-QA policy no longer authorizes this checkout",
    });
  });
});
