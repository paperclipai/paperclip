/**
 * Tests for the GitHub webhook receiver. Two layers:
 *   - Pure functions (identifier extraction, signature verification,
 *     event-context resolution) — no DB.
 *   - Full route integration (Express handler + DB + heartbeat wake).
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  __test_buildPrReviewerTaskKey,
  __test_buildPrReviewerWakeIdempotencyKey,
  __test_extractPaperclipIdentifiers,
  __test_hasPrReviewerRequestMention,
  __test_resolveEventContext,
  __test_shouldFirePrReviewerWake,
  __test_verifyGithubSignature,
  githubWebhookRoutes,
  type GithubWebhookConfig,
} from "../routes/github-webhook.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping GitHub webhook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("github-webhook pure helpers", () => {
  it("extracts paperclip identifiers from branch / title / body", () => {
    expect(__test_extractPaperclipIdentifiers("fix/BLO-3182-webflow-blog")).toEqual(["BLO-3182"]);
    expect(__test_extractPaperclipIdentifiers(null, "Fix BLO-3182: missing handler", undefined)).toEqual(["BLO-3182"]);
    // Multiple in body, deduped.
    expect(__test_extractPaperclipIdentifiers("Closes BLO-3182 and PCL-44")).toEqual(["BLO-3182", "PCL-44"]);
    expect(__test_extractPaperclipIdentifiers("Closes BLO-3182/3183 and PC1A2-7/8")).toEqual([
      "BLO-3182",
      "BLO-3183",
      "PC1A2-7",
      "PC1A2-8",
    ]);
    // 4-letter prefixes match (XBLO is itself a valid identifier shape;
    // paperclip company prefixes can be 2-10 letters). The lookup
    // against issues.identifier disambiguates -- only real prefixes
    // turn into wakes.
    expect(__test_extractPaperclipIdentifiers("XBLO-3182")).toEqual(["XBLO-3182"]);
    // But mid-word matches don't fire.
    expect(__test_extractPaperclipIdentifiers("frontend-X-44")).toEqual([]);
    // Punctuation around match is fine.
    expect(__test_extractPaperclipIdentifiers("(BLO-3182): work")).toEqual(["BLO-3182"]);
  });

  it("rejects payloads with bad signatures and accepts ones with good signatures", () => {
    const secret = "test-webhook-secret-do-not-use-in-prod";
    const body = Buffer.from(JSON.stringify({ action: "completed" }), "utf8");
    const goodSig =
      "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(__test_verifyGithubSignature(body, goodSig, secret)).toBe(true);
    expect(__test_verifyGithubSignature(body, "sha256=deadbeef", secret)).toBe(false);
    expect(__test_verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(__test_verifyGithubSignature(body, "sha1=" + goodSig.slice(7), secret)).toBe(false);
  });

  it("resolves wake context from a check_run.completed payload with PR head_branch", () => {
    const ctx = __test_resolveEventContext("check_run", {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow-blog",
        head_sha: "abc123",
        html_url: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow-blog" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_check_completed",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
      prUrl: "https://github.com/Blockcast/paperclip/pull/117",
      eventUrl: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
      headSha: "abc123",
    });
  });

  it("ignores non-completed check_run actions", () => {
    expect(
      __test_resolveEventContext("check_run", {
        action: "created",
        check_run: { head_branch: "fix/BLO-3182" },
      }),
    ).toBeNull();
  });

  it("ignores pull_request synchronize to avoid push-thrash", () => {
    expect(
      __test_resolveEventContext("pull_request", {
        action: "synchronize",
        pull_request: { head: { ref: "fix/BLO-3182" } },
      }),
    ).toBeNull();
  });

  it("resolves a wake reason for pull_request opened", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 200,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/200",
        head: { ref: "feat/BLO-3182", sha: "def456" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_pr_opened",
      prNumber: 200,
      prTitle: "Fix BLO-3182 webflow blog",
      prUrl: "https://github.com/Blockcast/paperclip/pull/200",
      eventUrl: "https://github.com/Blockcast/paperclip/pull/200",
      headSha: "def456",
    });
  });

  it("extracts the PR author login from pull_request.opened for the self-review-skip gate (BLO-9293)", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 235,
        title: "Fix BLO-9293",
        body: null,
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/235",
        head: { ref: "fix/BLO-9293", sha: "9f3ac21" },
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });
    expect(ctx).toMatchObject({
      wakeReason: "github_pr_opened",
      prNumber: 235,
      prAuthorLogin: "allyblockcast[bot]",
    });
  });

  it("resolves pull_request reopened as a reviewer wake signal (BLO-7426)", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "reopened",
      pull_request: {
        number: 980,
        title: "Retry review for BLO-7426",
        body: null,
        head: { ref: "fix/BLO-7426-reopen-wake" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-7426"],
      wakeReason: "github_pr_reopened",
      prNumber: 980,
      repoFullName: "Blockcast/magma",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(true);
    if (!ctx || !ctx.prNumber) {
      throw new Error("expected reopened pull_request context with PR number");
    }
    // @ts-expect-error – test fixture omits the prNumber field required by the narrow union
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx, "delivery-reopened")).toBe(
      "pr_review:Blockcast/magma:980:github_pr_reopened",
    );
  });

  it("treats @ally in a PR comment as an explicit reviewer wake request", () => {
    expect(__test_hasPrReviewerRequestMention("@ally re-review please")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("cc @Ally after the fix")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("@blockcast-ci-packages re-review please")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("@allyblockcast please review")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("cc @AllyBlockcast after the fix")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("ally should not match without the tag")).toBe(false);
    expect(__test_hasPrReviewerRequestMention("email me at ops@ally.example")).toBe(false);

    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 47,
        title: "BLO-6000 migrate auth",
        body: null,
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/47",
        pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/47" },
      },
      comment: {
        id: 123456,
        body: "@ally re-review requested. Auth branch is refreshed and Docker builder passed.",
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });

    expect(ctx).toMatchObject({
      identifiers: ["BLO-6000"],
      wakeReason: "github_pr_review_requested",
      prNumber: 47,
      repoFullName: "Blockcast/Network-Operator-Portal",
      commentId: 123456,
      commentAuthorLogin: "kkroo",
      commentBody: "@ally re-review requested. Auth branch is refreshed and Docker builder passed.",
      prUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47",
      eventUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
      commentUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
    });
    if (!__test_shouldFirePrReviewerWake(ctx)) {
      throw new Error("expected @ally PR comment to fire a reviewer wake");
    }
    expect(__test_buildPrReviewerTaskKey(ctx)).toBe(
      "pr_review:Blockcast/Network-Operator-Portal:47",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx, "delivery-1")).toBe(
      "pr_review:Blockcast/Network-Operator-Portal:47:github_pr_review_requested:comment:123456",
    );
  });

  it("ignores issue comments that are not PR @ally review requests", () => {
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 47,
          title: "BLO-6000 migrate auth",
          pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/47" },
        },
        comment: { id: 123456, body: "Looks good to me", user: { login: "kkroo" } },
        repository: { full_name: "Blockcast/Network-Operator-Portal" },
      }),
    ).toBeNull();
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: { number: 47, title: "BLO-6000 not a PR" },
        comment: { id: 123456, body: "@ally re-review please", user: { login: "kkroo" } },
        repository: { full_name: "Blockcast/Network-Operator-Portal" },
      }),
    ).toBeNull();
  });

  it("extracts review body / state / author from pull_request_review.submitted so the assignee wake can render it inline (BLO-6300)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat(cdn): BLO-5269 aggregator",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/953",
        head: { ref: "feat/BLO-5269", sha: "feedface" },
      },
      review: {
        body: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
        state: "commented",
        html_url: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-5269"],
      wakeReason: "github_pr_review_submitted",
      prNumber: 953,
      repoFullName: "Blockcast/magma",
      reviewBody: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
      reviewState: "commented",
      reviewAuthorLogin: "ally",
      prUrl: "https://github.com/Blockcast/magma/pull/953",
      eventUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
      reviewUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
      headSha: "feedface",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(true);
  });

  it("truncates oversize review bodies to ~4KB with a marker so the contextSnapshot row stays small (BLO-6300)", () => {
    // 5000-byte body — 1KB over the 4096-byte cap.
    const longBody = "x".repeat(5000);
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat: BLO-5269",
        head: { ref: "feat/BLO-5269" },
      },
      review: {
        body: longBody,
        state: "commented",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx?.reviewBody).toMatch(/…\(truncated\)$/);
    // 4096-byte body + truncation marker (~14 bytes), but always less than
    // the raw 5000 bytes — confirms we actually cut something.
    expect(ctx?.reviewBody?.length).toBeLessThan(5000);
  });

  it("returns null reviewBody when the reviewer submitted an empty body (state-only review)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        head: { ref: "feat/BLO-5269" },
      },
      review: {
        body: "",
        state: "approved",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx?.reviewBody).toBeNull();
    expect(ctx?.reviewState).toBe("approved");
  });
});

describeEmbeddedPostgres("github-webhook route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const webhookSecret = "test-webhook-secret-do-not-use-in-prod";
  const allowCcrotateGate: NonNullable<GithubWebhookConfig["heartbeatOptions"]>["ccrotateGate"] = {
    checkAdapter: async () => ({ allow: true }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-webhook-test-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    if (!db) return;
    // Drain queued/running heartbeat runs before TRUNCATE so the scheduler
    // isn't racing the cleanup (lifted from heartbeat-issue-liveness-escalation).
    // The wake-driving test enqueues a real heartbeat run that runs in a
    // fire-and-forget `void executeRun(...)` (see services/heartbeat.ts).
    // Under load that background execution can outlive the test it was spawned
    // in; if so, we force-finalize the row so the FK cascade in TRUNCATE isn't
    // blocked on in-flight row locks. The 30s drain budget absorbs CI runner
    // variance without sticking forever.
    const drainDeadline = Date.now() + 30_000;
    let idlePolls = 0;
    while (Date.now() < drainDeadline) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function buildApp(config: Pick<GithubWebhookConfig, "prReviewerAgentId" | "heartbeatOptions"> = {}) {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, {
      webhookSecret,
      ...config,
      heartbeatOptions: {
        ccrotateGate: allowCcrotateGate,
        skipQueuedRunDispatch: true,
        ...config.heartbeatOptions,
      },
    }));
    return app;
  }

  function signedRequest(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const signature =
      "sha256=" + crypto.createHmac("sha256", webhookSecret).update(Buffer.from(body, "utf8")).digest("hex");
    return { body, signature };
  }

  async function seedIssueWithIdentifier(identifier: string, opts?: { status?: string; assignee?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = identifier.split("-")[0]!;
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: opts?.assignee === false ? null : agentId,
      issueNumber: Number(identifier.split("-")[1] ?? 1),
      identifier,
    });
    return { companyId, agentId, issueId };
  }

  async function seedCompanyAndAgent(opts?: { agentName?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts?.agentName ?? "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("rejects unsigned requests with 401", async () => {
    const app = buildApp();
    const { body, signature: _ } = signedRequest({ action: "completed", check_run: { head_branch: "fix/X-1" } });
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("503s when the webhook secret is not configured", async () => {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    }}));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, { webhookSecret: null }));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", "sha256=anything")
      .set("content-type", "application/json")
      .send(Buffer.from("{}", "utf8"));
    expect(res.status).toBe(503);
  });

  it("ignores events not in the wake-driving set", async () => {
    const app = buildApp();
    const payload = { action: "opened", issue: {} };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "push" });
  });

  it("skips terminal-status issues -- a stale CI ping shouldn't reopen done work", async () => {
    const { agentId } = await seedIssueWithIdentifier("BLO-3000", { status: "done" });
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3000",
        pull_requests: [{ number: 50, head: { ref: "fix/BLO-3000" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.wakes).toHaveLength(0);
    expect(res.body.skipped).toEqual([
      { issueIdentifier: "BLO-3000", reason: "terminal_status" },
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(0);
  });

  it("acks events with no matching paperclip issue without erroring", async () => {
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/UNKNOWN-1234",
        pull_requests: [{ number: 1, head: { ref: "fix/UNKNOWN-1234" } }],
      },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "no_matching_issue", identifiers: ["UNKNOWN-1234"] });
  });

  it("does not coalesce reviewer PR wakes into a thin null-scope automation run (BLO-7457)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        wakeReason: "github_pr_opened",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
      },
    });

    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Migrate members page",
        body: null,
        head: { ref: "migration-blo-4959-members-page" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-7457")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const activeRun = runs.find((run) => run.id === activeRunId);
    expect(activeRun?.contextSnapshot).toMatchObject({
      wakeReason: "github_pr_opened",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
    });
    expect((activeRun?.contextSnapshot as Record<string, unknown> | undefined)?.githubPrNumber).toBeUndefined();

    const reviewerRun = runs.find((run) => run.id !== activeRunId);
    expect(reviewerRun?.status).toBe("queued");
    expect(reviewerRun?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:976",
      wakeReason: "github_pr_opened",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      commentSource: "github",
      githubEvent: "pull_request",
      githubDeliveryId: "delivery-blo-7457",
      githubPrNumber: 976,
      githubRepoFullName: "Blockcast/magma",
      reviewKind: "pr_review",
      prRole: "reviewer",
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.map((wake) => wake.status)).not.toContain("coalesced");
    expect(wakes).toContainEqual(expect.objectContaining({
      status: "queued",
      reason: "github_pr_opened",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:976",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-blo-7457",
        prNumber: 976,
        repoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
      }),
    }));
  });

  it("drives a reviewer wake for pull_request.reopened even without a paperclip identifier (BLO-7426)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "reopened",
      pull_request: {
        number: 980,
        title: "Retry reviewer wake",
        body: null,
        head: { ref: "retry-review" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-7426")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:980",
        wakeReason: "github_pr_reopened",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
        commentSource: "github",
        githubEvent: "pull_request",
        githubDeliveryId: "delivery-blo-7426",
        githubPrNumber: 980,
        githubRepoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
        prRole: "reviewer",
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      reason: "github_pr_reopened",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:980",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-blo-7426",
        prNumber: 980,
        repoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
      }),
    });
  });

  it("drives a wake on check_run.completed when the PR head_branch references a paperclip issue (CI completion)", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("BLO-3182");
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow",
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-abc-123")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.wakes).toHaveLength(1);
    expect(res.body.wakes[0]).toMatchObject({
      issueIdentifier: "BLO-3182",
      agentId,
    });
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    const payload0 = wakes[0]!.payload as Record<string, unknown>;
    expect(payload0).toMatchObject({
      issueId,
      source: "github",
      event: "check_run",
      deliveryId: "delivery-abc-123",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
      prUrl: "https://github.com/Blockcast/paperclip/pull/117",
      paperclipIdentifiers: ["BLO-3182"],
    });
    expect(wakes[0]!.reason).toBe("github_check_completed");
  });
});
