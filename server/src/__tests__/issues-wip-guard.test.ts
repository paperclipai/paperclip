import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres WIP guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService WIP guard", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wip-guard-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: "WIP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows checkout when agent has fewer than 2 in-progress issues", async () => {
    const issueId = randomUUID();
    const existingIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(issues).values([
      {
        id: existingIssueId,
        companyId,
        title: "Existing in-progress",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: issueId,
        companyId,
        title: "Issue to checkout",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const result = await svc.checkout(issueId, agentId, ["todo"], runId);
    expect(result).toBeTruthy();
    expect(result!.status).toBe("in_progress");
  });

  it("rejects checkout when agent already has 2 in-progress issues", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 1",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 2",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: issueId,
        companyId,
        title: "Issue to checkout",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    await expect(svc.checkout(issueId, agentId, ["todo"], runId)).rejects.toThrow(
      "Agent has reached the maximum number of in-progress issues",
    );
  });

  it("allows checkout with override when agent has 2 in-progress issues", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 1",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 2",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: issueId,
        companyId,
        title: "Issue to checkout",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const result = await svc.checkout(issueId, agentId, ["todo"], runId, {
      overrideWipLimit: true,
    });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("in_progress");
  });

  it("rejects update to in_progress when agent WIP limit reached", async () => {
    const issueId = randomUUID();

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 1",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 2",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: issueId,
        companyId,
        title: "Issue to update",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    await expect(svc.update(issueId, { status: "in_progress" })).rejects.toThrow(
      "Agent has reached the maximum number of in-progress issues",
    );
  });

  it("allows update to in_progress with override", async () => {
    const issueId = randomUUID();

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 1",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 2",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: issueId,
        companyId,
        title: "Issue to update",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const result = await svc.update(issueId, { status: "in_progress" }, { overrideWipLimit: true });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("in_progress");
  });

  it("does not trigger guard when issue is already in_progress", async () => {
    const issueId = randomUUID();

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 1",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "In-progress 2",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: issueId,
        companyId,
        title: "Already in-progress",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    // Updating other fields on an already in_progress issue should not trigger the guard
    const result = await svc.update(issueId, { title: "Updated title" });
    expect(result).toBeTruthy();
    expect(result!.title).toBe("Updated title");
  });

  it("does not count issues from other agents", async () => {
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Other agent in-progress 1",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Other agent in-progress 2",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
      {
        id: issueId,
        companyId,
        title: "Issue to checkout",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const result = await svc.checkout(issueId, agentId, ["todo"], runId);
    expect(result).toBeTruthy();
    expect(result!.status).toBe("in_progress");
  });
});
