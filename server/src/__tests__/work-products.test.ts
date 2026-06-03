import { describe, expect, it, vi } from "vitest";
const mockGetObject = vi.hoisted(() => vi.fn());

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    getObject: mockGetObject,
  }),
}));

import { escapeLikePattern, workProductService } from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDeliverableQueryRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-05-01T00:00:00.000Z");
  return {
    id: "deliverable-1",
    deliverable_source: "artifact",
    company_id: "company-1",
    project_id: "project-1",
    issue_id: "issue-child",
    type: "artifact",
    provider: "openclaw_gateway",
    external_id: null,
    title: "Final report",
    url: null,
    status: "ready",
    review_state: "none",
    is_primary: true,
    health_status: "healthy",
    summary: null,
    metadata: {
      attachmentId: "attachment-1",
      contentPath: "/api/attachments/attachment-1/content",
      sourcePath: "deliverables/final-report.pdf",
      contentType: "application/pdf",
      byteSize: 2048,
      originalFilename: "final-report.pdf",
    },
    created_by_run_id: null,
    execution_workspace_id: null,
    runtime_service_id: null,
    created_at: now,
    updated_at: now,
    document_key: null,
    document_format: null,
    document_body: null,
    ci_id: "issue-child",
    ci_identifier: "PAP-12",
    ci_title: "Write report",
    ci_status: "done",
    ri_id: "issue-root",
    ri_identifier: "PAP-1",
    ri_title: "Quarterly review",
    ri_status: "in_progress",
    agent_id: null,
    agent_name: null,
    agent_url_key: null,
    agent_icon: null,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("escapes SQL LIKE metacharacters for deliverable search", () => {
    expect(escapeLikePattern("report_2024")).toBe("report\\_2024");
    expect(escapeLikePattern("100% done")).toBe("100\\% done");
    expect(escapeLikePattern("path\\name")).toBe("path\\\\name");
  });

  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });

  it("loads deliverable ancestors via one recursive query", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([createDeliverableQueryRow()])
      .mockResolvedValueOnce([
        {
          id: "issue-parent",
          identifier: "PAP-7",
          title: "Middle issue",
          status: "in_progress",
        },
        {
          id: "issue-root",
          identifier: "PAP-1",
          title: "Quarterly review",
          status: "in_progress",
        },
      ]);
    const select = vi.fn(() => {
      throw new Error("should not call select in ancestor loading path");
    });

    const svc = workProductService({ execute, select } as any);
    const deliverable = await svc.getDeliverableById("deliverable-1");

    expect(deliverable?.id).toBe("deliverable-1");
    expect(deliverable?.ancestors).toEqual([
      {
        id: "issue-parent",
        identifier: "PAP-7",
        title: "Middle issue",
        status: "in_progress",
      },
      {
        id: "issue-root",
        identifier: "PAP-1",
        title: "Quarterly review",
        status: "in_progress",
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
  });

  it("maps issue documents into company deliverables", async () => {
    const now = new Date("2026-05-02T00:00:00.000Z");
    const execute = vi.fn().mockResolvedValue([
      createDeliverableQueryRow({
        id: "doc-deliverable-1",
        deliverable_source: "document",
        title: "Company Requirements",
        metadata: null,
        document_key: "company-requirements",
        document_format: "markdown",
        document_body: null,
        document_byte_size: 15,
        created_at: now,
        updated_at: now,
      }),
    ]);

    const svc = workProductService({ execute } as any);
    const items = await svc.listDeliverablesForCompany("company-1", { limit: 50, offset: 0 });

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("doc-deliverable-1");
    expect(items[0]?.contentPath).toBe("/api/deliverables/doc-deliverable-1/content");
    expect(items[0]?.contentType).toContain("text/markdown");
    expect(items[0]?.byteSize).toBe(15);
    expect(items[0]?.originalFilename).toBe("company-requirements.md");
  });

  it("prefers the deliverable title for generic document filenames", async () => {
    const now = new Date("2026-05-02T00:00:00.000Z");
    const execute = vi.fn().mockResolvedValue([
      createDeliverableQueryRow({
        id: "doc-deliverable-2",
        deliverable_source: "document",
        title: "Quarterly Closeout",
        metadata: null,
        document_key: "deliverable",
        document_format: "markdown",
        document_body: "# Quarterly Closeout",
        document_byte_size: 20,
        created_at: now,
        updated_at: now,
      }),
    ]);

    const svc = workProductService({ execute } as any);
    const items = await svc.listDeliverablesForCompany("company-1", { limit: 50, offset: 0 });

    expect(items[0]?.originalFilename).toBe("quarterly-closeout.md");
  });

  it("falls back to the markdown H1 for generic document filenames when the stored title is null", async () => {
    const now = new Date("2026-05-02T00:00:00.000Z");
    const execute = vi.fn().mockResolvedValue([
      createDeliverableQueryRow({
        id: "doc-deliverable-3",
        deliverable_source: "document",
        title: null,
        metadata: null,
        document_key: "deliverable",
        document_format: "markdown",
        document_body: "# Legacy Closeout\n\nBody copy",
        document_byte_size: 26,
        created_at: now,
        updated_at: now,
      }),
    ]);

    const svc = workProductService({ execute } as any);
    const items = await svc.listDeliverablesForCompany("company-1", { limit: 50, offset: 0 });

    expect(items[0]?.originalFilename).toBe("legacy-closeout.md");
  });

  it("uses the markdown H1 for generic document download filenames when the stored title is null", async () => {
    const now = new Date("2026-05-02T00:00:00.000Z");
    const execute = vi.fn().mockResolvedValue([{
      id: "doc-deliverable-4",
      company_id: "company-1",
      key: "document",
      format: "markdown",
      body: "# Legacy Download\n\nBody copy",
      title: null,
    }]);

    const svc = workProductService({ execute } as any);
    const document = await svc.getDeliverableDocumentContentById("doc-deliverable-4");

    expect(document).toMatchObject({
      id: "doc-deliverable-4",
      filename: "legacy-download.md",
      title: null,
    });
  });

  it("truncates inline document previews by UTF-8 byte length", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        createDeliverableQueryRow({
          deliverable_source: "document",
          metadata: null,
          document_key: "plan",
          document_format: "markdown",
          document_body: `${"a".repeat((64 * 1024) - 1)}🙂`,
          document_byte_size: (64 * 1024) + 3,
        }),
      ])
      .mockResolvedValueOnce([]);

    const svc = workProductService({ execute } as any);
    const deliverable = await svc.getDeliverableById("deliverable-1");

    expect(deliverable?.preview?.truncated).toBe(true);
    expect(deliverable?.preview?.body.endsWith("🙂")).toBe(false);
    expect(Buffer.byteLength(deliverable?.preview?.body ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("returns the deliverable when artifact preview loading fails", async () => {
    mockGetObject.mockRejectedValueOnce(new Error("storage unavailable"));

    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        createDeliverableQueryRow({
          metadata: {
            attachmentId: "attachment-1",
            contentPath: "/api/attachments/attachment-1/content",
            sourcePath: "deliverables/final-report.md",
            contentType: "text/markdown; charset=utf-8",
            byteSize: 32,
            originalFilename: "final-report.md",
          },
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          company_id: "company-1",
          object_key: "assets/final-report.md",
        },
      ]);

    const svc = workProductService({ execute } as any);
    const deliverable = await svc.getDeliverableById("deliverable-1");

    expect(deliverable?.id).toBe("deliverable-1");
    expect(deliverable?.preview).toBeNull();
    expect(mockGetObject).toHaveBeenCalledWith("company-1", "assets/final-report.md");
  });

  it("maps workflow-backed deliverables into deliverable detail records", async () => {
    const now = new Date("2026-05-03T00:00:00.000Z");
    const rows = [{
      id: "workflow-deliverable-1",
      companyId: "company-1",
      workflowId: "workflow-1",
      workflowRunId: "run-1",
      title: "Workflow brief",
      summary: "Generated by workflow",
      audience: "human",
      contentType: "text/markdown; charset=utf-8",
      contentPath: null,
      contentBody: "# Workflow brief",
      byteSize: 16,
      originalFilename: "workflow-brief.md",
      createdAt: now,
      updatedAt: now,
      workflowTitle: "Brief generator",
    }];
    const where = vi.fn(() => ({
      then: async (callback: (input: typeof rows) => unknown) => callback(rows),
    }));
    const innerJoin = vi.fn(() => ({ innerJoin, where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));

    const svc = workProductService({ select } as any);
    const deliverable = await svc.getWorkflowDeliverableById("workflow-deliverable-1");

    expect(deliverable).toMatchObject({
      id: "workflow-deliverable-1",
      sourceKind: "workflow",
      childIssue: null,
      rootIssue: null,
      workflow: {
        id: "workflow-1",
        title: "Brief generator",
        runId: "run-1",
      },
      preview: {
        kind: "markdown",
        body: "# Workflow brief",
        truncated: false,
      },
    });
  });
});
