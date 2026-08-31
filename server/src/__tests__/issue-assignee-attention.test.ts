import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue assignee attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue assignee attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-assignee-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createAgent(input: {
    companyId: string;
    name: string;
    status: string;
    errorReason?: string | null;
    pauseReason?: string | null;
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name,
      role: "engineer",
      status: input.status,
      errorReason: input.errorReason ?? null,
      pauseReason: input.pauseReason ?? null,
    });
    return agentId;
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    status: string;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: `Issue ${input.identifier}`,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  it("surfaces an error-status assignee on active issues with a sanitized reason", async () => {
    const companyId = await createCompany("IAA");
    const errorAgentId = await createAgent({
      companyId,
      name: "Errored Agent",
      status: "error",
      errorReason: "Run failed: `adapter` crashed — see [logs](https://internal/logs)\n\n```\nstack trace secret\n```",
    });
    const issueId = await insertIssue({
      companyId,
      identifier: "IAA-1",
      status: "in_progress",
      assigneeAgentId: errorAgentId,
    });

    const row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention).toMatchObject({
      state: "agent_error",
      agentId: errorAgentId,
      agentName: "Errored Agent",
    });
    const attention = row?.assigneeAttention;
    const excerpt = attention?.state === "agent_error" ? attention.errorReasonExcerpt ?? "" : "";
    expect(excerpt).toContain("Run failed");
    expect(excerpt).toContain("adapter crashed");
    // Markdown syntax, links, and fenced blocks are stripped from the excerpt.
    expect(excerpt).not.toContain("`");
    expect(excerpt).not.toContain("https://internal/logs");
    expect(excerpt).not.toContain("stack trace secret");
  });

  it("caps the error reason excerpt length", async () => {
    const companyId = await createCompany("IAB");
    const errorAgentId = await createAgent({
      companyId,
      name: "Verbose Agent",
      status: "error",
      errorReason: "x".repeat(500),
    });
    const issueId = await insertIssue({
      companyId,
      identifier: "IAB-1",
      status: "todo",
      assigneeAgentId: errorAgentId,
    });

    const row = (await svc.list(companyId, { status: "todo" })).find((issue) => issue.id === issueId);
    const attention = row?.assigneeAttention;
    const excerpt = attention?.state === "agent_error" ? attention.errorReasonExcerpt ?? "" : "";
    expect(excerpt.length).toBeLessThanOrEqual(163);
    expect(excerpt.endsWith("...")).toBe(true);
  });

  it("does not flag idle assignees or unassigned issues", async () => {
    const companyId = await createCompany("IAC");
    const idleAgentId = await createAgent({ companyId, name: "Idle Agent", status: "idle" });
    const idleIssueId = await insertIssue({
      companyId,
      identifier: "IAC-1",
      status: "in_progress",
      assigneeAgentId: idleAgentId,
    });
    const unassignedIssueId = await insertIssue({
      companyId,
      identifier: "IAC-2",
      status: "in_progress",
      assigneeAgentId: null,
    });

    const rows = await svc.list(companyId, { status: "in_progress" });
    const idleRow = rows.find((issue) => issue.id === idleIssueId);
    const unassignedRow = rows.find((issue) => issue.id === unassignedIssueId);
    expect(idleRow).toBeDefined();
    expect(idleRow?.assigneeAttention).toBeUndefined();
    expect(unassignedRow).toBeDefined();
    expect(unassignedRow?.assigneeAttention).toBeUndefined();
  });

  it("never reads agent status across company boundaries", async () => {
    const companyId = await createCompany("IAD");
    const otherCompanyId = await createCompany("IAE");
    const foreignErrorAgentId = await createAgent({
      companyId: otherCompanyId,
      name: "Foreign Errored Agent",
      status: "error",
      errorReason: "foreign company secret reason",
    });
    // Data-corruption shape: an issue pointing at another company's agent must
    // not leak that agent's status or reason.
    const issueId = await insertIssue({
      companyId,
      identifier: "IAD-1",
      status: "in_progress",
      assigneeAgentId: foreignErrorAgentId,
    });

    const row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row).toBeDefined();
    expect(row?.assigneeAttention).toBeUndefined();

    const detailMap = await svc.listAssigneeAttention(companyId, [
      { id: issueId, companyId, status: "in_progress", assigneeAgentId: foreignErrorAgentId },
    ]);
    expect(detailMap.size).toBe(0);
  });

  it("skips terminal and parked issues even when the assignee is errored", async () => {
    const companyId = await createCompany("IAF");
    const errorAgentId = await createAgent({ companyId, name: "Errored Agent", status: "error", errorReason: "boom" });
    const doneIssueId = await insertIssue({
      companyId,
      identifier: "IAF-1",
      status: "done",
      assigneeAgentId: errorAgentId,
    });
    const backlogIssueId = await insertIssue({
      companyId,
      identifier: "IAF-2",
      status: "backlog",
      assigneeAgentId: errorAgentId,
    });

    const rows = await svc.list(companyId, { status: "done,backlog" });
    expect(rows.find((issue) => issue.id === doneIssueId)?.assigneeAttention).toBeUndefined();
    expect(rows.find((issue) => issue.id === backlogIssueId)?.assigneeAttention).toBeUndefined();
  });

  it("surfaces a paused assignee on active issues as agent_paused with a sanitized reason", async () => {
    const companyId = await createCompany("IAH");
    const pausedAgentId = await createAgent({
      companyId,
      name: "Paused Agent",
      status: "paused",
      pauseReason: "Paused by operator: `budget` review — see [thread](https://internal/thread)",
    });
    const issueId = await insertIssue({
      companyId,
      identifier: "IAH-1",
      status: "in_progress",
      assigneeAgentId: pausedAgentId,
    });

    const row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention).toMatchObject({
      state: "agent_paused",
      agentId: pausedAgentId,
      agentName: "Paused Agent",
    });
    const attention = row?.assigneeAttention;
    const excerpt = attention?.state === "agent_paused" ? attention.pauseReasonExcerpt ?? "" : "";
    expect(excerpt).toContain("Paused by operator");
    expect(excerpt).toContain("budget review");
    expect(excerpt).not.toContain("`");
    expect(excerpt).not.toContain("https://internal/thread");
  });

  it("skips terminal and parked issues even when the assignee is paused", async () => {
    const companyId = await createCompany("IAI");
    const pausedAgentId = await createAgent({
      companyId,
      name: "Paused Agent",
      status: "paused",
      pauseReason: "manual",
    });
    const doneIssueId = await insertIssue({
      companyId,
      identifier: "IAI-1",
      status: "done",
      assigneeAgentId: pausedAgentId,
    });
    const backlogIssueId = await insertIssue({
      companyId,
      identifier: "IAI-2",
      status: "backlog",
      assigneeAgentId: pausedAgentId,
    });
    const cancelledIssueId = await insertIssue({
      companyId,
      identifier: "IAI-3",
      status: "cancelled",
      assigneeAgentId: pausedAgentId,
    });

    const rows = await svc.list(companyId, { status: "done,backlog,cancelled" });
    expect(rows.find((issue) => issue.id === doneIssueId)?.assigneeAttention).toBeUndefined();
    expect(rows.find((issue) => issue.id === backlogIssueId)?.assigneeAttention).toBeUndefined();
    expect(rows.find((issue) => issue.id === cancelledIssueId)?.assigneeAttention).toBeUndefined();
  });

  it("never reads a paused agent's reason across company boundaries", async () => {
    const companyId = await createCompany("IAJ");
    const otherCompanyId = await createCompany("IAK");
    const foreignPausedAgentId = await createAgent({
      companyId: otherCompanyId,
      name: "Foreign Paused Agent",
      status: "paused",
      pauseReason: "foreign company pause reason",
    });
    const issueId = await insertIssue({
      companyId,
      identifier: "IAJ-1",
      status: "in_progress",
      assigneeAgentId: foreignPausedAgentId,
    });

    const row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row).toBeDefined();
    expect(row?.assigneeAttention).toBeUndefined();

    const detailMap = await svc.listAssigneeAttention(companyId, [
      { id: issueId, companyId, status: "in_progress", assigneeAgentId: foreignPausedAgentId },
    ]);
    expect(detailMap.size).toBe(0);
  });

  it("appears and disappears as the agent's status changes", async () => {
    const companyId = await createCompany("IAG");
    const agentId = await createAgent({ companyId, name: "Flappy Agent", status: "error", errorReason: "boom" });
    const issueId = await insertIssue({
      companyId,
      identifier: "IAG-1",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    let row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention?.state).toBe("agent_error");

    // Same transition Clear error performs on the agent row.
    await db
      .update(agents)
      .set({ status: "idle", errorReason: null })
      .where(eq(agents.id, agentId));

    row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention).toBeUndefined();
  });

  it("tracks pause and resume transitions in both directions", async () => {
    const companyId = await createCompany("IAL");
    const agentId = await createAgent({ companyId, name: "Cycling Agent", status: "idle" });
    const issueId = await insertIssue({
      companyId,
      identifier: "IAL-1",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    let row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention).toBeUndefined();

    // Same transition the pause action performs on the agent row.
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "manual" })
      .where(eq(agents.id, agentId));

    row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention).toMatchObject({ state: "agent_paused", agentId });

    // Same transition resume performs.
    await db
      .update(agents)
      .set({ status: "idle", pauseReason: null })
      .where(eq(agents.id, agentId));

    row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
    expect(row?.assigneeAttention).toBeUndefined();
  });
});
