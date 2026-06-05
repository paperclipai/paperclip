import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CODEX_LIMIT_LABEL_COLOR,
  CODEX_LIMIT_LABEL_NAME,
  issueService,
} from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres codex-limit label tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService codex-limit label helpers (KSI-687)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-codex-limit-label-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string, opts?: {
    assigneeAgentId?: string | null;
    status?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue under usage-limit",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: opts?.assigneeAgentId ?? null,
      createdAt: new Date(),
    });
    return issueId;
  }

  async function seedAgent(companyId: string, name = "Codex") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("ensureCodexLimitLabel creates the label idempotently with the documented color", async () => {
    const companyId = await seedCompany();
    const svc = issueService(db);

    const labelId = await svc.ensureCodexLimitLabel(companyId);
    expect(labelId).toBeTruthy();

    const sameLabelId = await svc.ensureCodexLimitLabel(companyId);
    expect(sameLabelId).toBe(labelId);

    const all = await db
      .select()
      .from(labels)
      .where(and(eq(labels.companyId, companyId), eq(labels.name, CODEX_LIMIT_LABEL_NAME)));
    expect(all).toHaveLength(1);
    expect(all[0].color).toBe(CODEX_LIMIT_LABEL_COLOR);
  });

  it("getCodexLimitLabelId returns null before the label exists and the labelId after", async () => {
    const companyId = await seedCompany();
    const svc = issueService(db);

    expect(await svc.getCodexLimitLabelId(companyId)).toBeNull();
    const labelId = await svc.ensureCodexLimitLabel(companyId);
    expect(await svc.getCodexLimitLabelId(companyId)).toBe(labelId);
  });

  it("addCodexLimitLabelToIssue applies the label and is idempotent", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const svc = issueService(db);

    await svc.addCodexLimitLabelToIssue(issueId, companyId);
    await svc.addCodexLimitLabelToIssue(issueId, companyId);

    const rows = await db
      .select()
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issueId));
    expect(rows).toHaveLength(1);

    const label = await db
      .select()
      .from(labels)
      .where(eq(labels.id, rows[0].labelId))
      .then((r) => r[0]);
    expect(label.name).toBe(CODEX_LIMIT_LABEL_NAME);
  });

  it("clearCodexLimitLabelIfApplicable is a no-op when the label has not been created", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const svc = issueService(db);

    const removed = await svc.clearCodexLimitLabelIfApplicable(issueId, companyId);
    expect(removed).toBe(false);

    const labelRows = await db.select().from(labels).where(eq(labels.companyId, companyId));
    expect(labelRows).toHaveLength(0);
  });

  it("clearCodexLimitLabelIfApplicable removes the label when applied and is idempotent on subsequent calls", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const svc = issueService(db);

    await svc.addCodexLimitLabelToIssue(issueId, companyId);
    expect(await svc.clearCodexLimitLabelIfApplicable(issueId, companyId)).toBe(true);
    expect(await svc.clearCodexLimitLabelIfApplicable(issueId, companyId)).toBe(false);

    const remaining = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issueId));
    expect(remaining).toHaveLength(0);
  });

  it("update() clears codex-limit label when the agent assignee changes (symmetric with reassign during blocked)", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "CodexA");
    const agentB = await seedAgent(companyId, "CodexB");
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentA, status: "blocked" });
    const svc = issueService(db);

    await svc.addCodexLimitLabelToIssue(issueId, companyId);
    const before = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issueId));
    expect(before).toHaveLength(1);

    await svc.update(issueId, { assigneeAgentId: agentB });

    const after = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issueId));
    expect(after).toHaveLength(0);
  });

  it("update() does NOT clear codex-limit label when the assignee did not change", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "CodexA");
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentA, status: "blocked" });
    const svc = issueService(db);

    await svc.addCodexLimitLabelToIssue(issueId, companyId);

    // Update an unrelated field; assignee unchanged.
    await svc.update(issueId, { priority: "high" });

    const after = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issueId));
    expect(after).toHaveLength(1);
  });

  it("update() does NOT clear codex-limit label when the caller is explicitly managing labelIds", async () => {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "CodexA");
    const agentB = await seedAgent(companyId, "CodexB");
    const issueId = await seedIssue(companyId, { assigneeAgentId: agentA, status: "blocked" });
    const svc = issueService(db);

    const codexLimitLabelId = await svc.ensureCodexLimitLabel(companyId);

    // Caller explicitly retains the label across the reassign by passing labelIds.
    await svc.update(issueId, {
      assigneeAgentId: agentB,
      labelIds: [codexLimitLabelId],
    });

    const after = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issueId));
    expect(after).toHaveLength(1);
    expect(after[0].labelId).toBe(codexLimitLabelId);
  });
});
