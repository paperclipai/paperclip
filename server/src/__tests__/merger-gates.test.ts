import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
}));

vi.mock("../services/work-products.js", () => ({
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  const [{ errorHandler }, { workProductRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/work-products.js") as Promise<typeof import("../routes/work-products.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", workProductRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("merger gates", () => {
  beforeEach(() => {
    mockWorkProductService.getById.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
  });

  it("returns 404 when work product is not found", async () => {
    mockWorkProductService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).get("/api/work-products/wp-1/merge-gates");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Work product not found" });
  }, 30000);

  it("returns gate failure for non-PR work product", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: "wp-1",
      companyId: "company-1",
      issueId: "issue-1",
      type: "branch",
    });

    const app = await createApp();
    const res = await request(app).get("/api/work-products/wp-1/merge-gates");

    expect(res.status).toBe(200);
    expect(res.body.canMerge).toBe(false);
    expect(res.body.gates).toHaveLength(1);
    expect(res.body.gates[0]).toEqual({
      gateId: "issue_approval",
      passed: false,
      reason: "Work product is not a pull request",
    });
  }, 30000);

  it("passes gate when PR has an approved approval", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: "wp-1",
      companyId: "company-1",
      issueId: "issue-1",
      type: "pull_request",
    });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      {
        id: "approval-1",
        status: "approved",
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/work-products/wp-1/merge-gates");

    expect(res.status).toBe(200);
    expect(res.body.canMerge).toBe(true);
    expect(res.body.gates).toHaveLength(1);
    expect(res.body.gates[0]).toEqual({
      gateId: "issue_approval",
      passed: true,
      reason: "Issue has at least one approved approval",
    });
  }, 30000);

  it("fails gate when PR has no approvals", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: "wp-1",
      companyId: "company-1",
      issueId: "issue-1",
      type: "pull_request",
    });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);

    const app = await createApp();
    const res = await request(app).get("/api/work-products/wp-1/merge-gates");

    expect(res.status).toBe(200);
    expect(res.body.canMerge).toBe(false);
    expect(res.body.gates).toHaveLength(1);
    expect(res.body.gates[0]).toEqual({
      gateId: "issue_approval",
      passed: false,
      reason: "No approvals linked to the issue",
    });
  }, 30000);

  it("fails gate when PR has only pending approvals", async () => {
    mockWorkProductService.getById.mockResolvedValue({
      id: "wp-1",
      companyId: "company-1",
      issueId: "issue-1",
      type: "pull_request",
    });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      {
        id: "approval-1",
        status: "pending",
      },
      {
        id: "approval-2",
        status: "rejected",
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/work-products/wp-1/merge-gates");

    expect(res.status).toBe(200);
    expect(res.body.canMerge).toBe(false);
    expect(res.body.gates).toHaveLength(1);
    expect(res.body.gates[0]).toEqual({
      gateId: "issue_approval",
      passed: false,
      reason: "No approved approval found for the issue",
    });
  }, 30000);
});
