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
  __test_extractPaperclipIdentifiers,
  __test_resolveEventContext,
  __test_verifyGithubSignature,
  githubWebhookRoutes,
} from "../routes/github-webhook.ts";
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
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow-blog" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_check_completed",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
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
        head: { ref: "feat/BLO-3182" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_pr_opened",
      prNumber: 200,
    });
  });
});

describeEmbeddedPostgres("github-webhook route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const webhookSecret = "test-webhook-secret-do-not-use-in-prod";

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

  function buildApp() {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, { webhookSecret }));
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
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "issue_comment" });
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

  // Kept LAST in the describe block on purpose: this test triggers a
  // fire-and-forget `void executeRun(claimedRun.id)` in services/heartbeat.ts
  // that can outlive the test under CI load. If any test ran after it, that
  // test's beforeEach TRUNCATE would block on ACCESS EXCLUSIVE waiting for
  // executeRun's row locks to drain — eventually tripping the 60s hook
  // timeout. afterAll tears down the whole temp db so leftover background
  // work is harmless once this is the final test.
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
    });
    expect(wakes[0]!.reason).toBe("github_check_completed");
  });
});
