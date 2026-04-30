import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping terminal guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issuesSvc.update — terminal state guard (POI-166)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupDoneIssue() {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal guard test issue",
      status: "done",
      completedAt: new Date(),
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
  }

  it("throws 422 when trying to reopen a done issue without allowTerminalReopen", async () => {
    await setupDoneIssue();
    const svc = issueService(db);

    await expect(svc.update(issueId, { status: "todo" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("allowTerminalReopen"),
    });
  });

  it("throws 422 when trying to reopen a cancelled issue without allowTerminalReopen", async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled issue",
      status: "cancelled",
      cancelledAt: new Date(),
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    const svc = issueService(db);
    await expect(svc.update(issueId, { status: "todo" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("allowTerminalReopen"),
    });
  });

  it("allows done → todo when allowTerminalReopen is true", async () => {
    await setupDoneIssue();
    const svc = issueService(db);

    const result = await svc.update(issueId, { status: "todo", allowTerminalReopen: true });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("todo");
  });

  it("does not block non-terminal → non-terminal transitions", async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent2",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-progress issue",
      status: "in_progress",
      assigneeAgentId: agentId,
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    const svc = issueService(db);
    const result = await svc.update(issueId, { status: "todo" });
    expect(result?.status).toBe("todo");
  });

  it("does not block terminal → terminal transitions (done → cancelled)", async () => {
    await setupDoneIssue();
    const svc = issueService(db);

    // done → cancelled is terminal-to-terminal, should not require allowTerminalReopen
    const result = await svc.update(issueId, { status: "cancelled" });
    expect(result?.status).toBe("cancelled");
  });
});

describeEmbeddedPostgres("svc.checkout — terminal state guard (POI-251)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-terminal-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupIssueWithStatus(status: "done" | "cancelled") {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CheckoutTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout terminal guard test issue",
      status,
      assigneeAgentId: agentId,
      ...(status === "done" ? { completedAt: new Date() } : { cancelledAt: new Date() }),
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
  }

  it("throws 422 when checking out a cancelled issue (test A)", async () => {
    await setupIssueWithStatus("cancelled");
    const svc = issueService(db);

    await expect(
      svc.checkout(issueId, agentId, ["cancelled"], null),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('status="cancelled"'),
    });
  });

  it("throws 422 when checking out a done issue (test B)", async () => {
    await setupIssueWithStatus("done");
    const svc = issueService(db);

    await expect(
      svc.checkout(issueId, agentId, ["done"], null),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('status="done"'),
    });
  });

  it("error detail includes issueId and status for cancelled checkout", async () => {
    await setupIssueWithStatus("cancelled");
    const svc = issueService(db);

    try {
      await svc.checkout(issueId, agentId, ["cancelled"], null);
      expect.fail("Expected checkout to throw");
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(422);
      expect((err as { details?: { issueId?: string; status?: string } }).details?.issueId).toBe(issueId);
      expect((err as { details?: { status?: string } }).details?.status).toBe("cancelled");
    }
  });

  it("allows checkout of a non-terminal issue (regression guard)", async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CheckoutRegressionAgent",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Todo issue for checkout regression",
      status: "todo",
      assigneeAgentId: agentId,
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    const svc = issueService(db);
    const result = await svc.checkout(issueId, agentId, ["todo"], null);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("in_progress");
  });

  it("allows checkout of a done issue when allowTerminalReopen is true", async () => {
    await setupIssueWithStatus("done");
    const svc = issueService(db);

    const result = await svc.checkout(issueId, agentId, ["done"], null, { allowTerminalReopen: true });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("in_progress");
  });

  it("POI-241 reproduction: cancelled issue stays cancelled when checkout fires without flag", async () => {
    await setupIssueWithStatus("cancelled");
    const svc = issueService(db);

    await expect(
      svc.checkout(issueId, agentId, ["cancelled"], null),
    ).rejects.toMatchObject({ status: 422 });

    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(row?.status).toBe("cancelled");
  });
});
