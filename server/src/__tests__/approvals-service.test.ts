import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvalComments, approvals, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { approvalService } from "../services/approvals.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval comment tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("approvalService.addComment idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof approvalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-comments-");
    db = createDb(tempDb.connectionString);
    svc = approvalService(db);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedApprovalWithRun() {
    const companyId = randomUUID();
    const approvalId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Approval comment company",
      issuePrefix: `APR${Math.floor(Math.random() * 1000)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Commenter",
      role: "general",
      adapterType: "process",
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });

    return { approvalId, runId, agentId };
  }

  it("returns the existing approval comment when the same run retries the same body", async () => {
    const { approvalId, runId, agentId } = await seedApprovalWithRun();

    const first = await svc.addComment(approvalId, "Ready for review.", { agentId, runId });
    const second = await svc.addComment(approvalId, "Ready for review.", { agentId, runId });

    expect(second.id).toBe(first.id);
    expect((first as { wasInserted?: boolean }).wasInserted).toBe(true);
    expect((second as { wasInserted?: boolean }).wasInserted).toBe(false);

    const rows = await db.select().from(approvalComments).where(eq(approvalComments.approvalId, approvalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.createdByRunId).toBe(runId);
  });

  it("does not deduplicate non-agent approval comments even when a run id is present", async () => {
    const { approvalId, runId } = await seedApprovalWithRun();

    const first = await svc.addComment(approvalId, "Board follow-up.", { userId: "user-1", runId });
    const second = await svc.addComment(approvalId, "Board follow-up.", { userId: "user-1", runId });

    expect(second.id).not.toBe(first.id);

    const rows = await db.select().from(approvalComments).where(eq(approvalComments.approvalId, approvalId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.idempotencyKey === null)).toBe(true);
  });
});
