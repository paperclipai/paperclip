import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpsertIssueDocument = vi.hoisted(() => vi.fn());

vi.mock("../services/documents.js", () => ({
  documentService: () => ({
    upsertIssueDocument: mockUpsertIssueDocument,
  }),
}));

function createSelectChain(rows: Array<Record<string, unknown>>) {
  const terminal = {
    then(callback: (rows: Array<Record<string, unknown>>) => unknown) {
      return Promise.resolve(callback(rows));
    },
  };
  const whereable = {
    where() {
      return terminal;
    },
  };
  return {
    from() {
      return {
        ...whereable,
        innerJoin() {
          return whereable;
        },
      };
    },
  };
}

function conflict(message: string, details?: unknown) {
  const error = new Error(message) as Error & { status?: number; details?: unknown };
  error.status = 409;
  error.details = details;
  return error;
}

function wrappedUniqueViolation() {
  return {
    message: 'Failed query: insert into "issue_documents" ... duplicate key value violates unique constraint',
    cause: {
      code: "23505",
      constraint_name: "issue_documents_company_issue_key_uq",
    },
  };
}

describe("refreshIssueContinuationSummary conflict recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("retries with the current base revision when the first system document write loses the create race", async () => {
    const { refreshIssueContinuationSummary } = await import("../services/issue-continuation-summary.js");
    let selectCall = 0;
    const currentSummary = {
      title: "Continuation Summary",
      body: "# Existing Continuation Summary",
      latestRevisionId: "revision-existing",
      latestRevisionNumber: 1,
      updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    };
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return createSelectChain([
            {
              id: "issue-1",
              identifier: "PAP-1",
              title: "Race the continuation summary",
              description: "Keep the issue resumable.",
              status: "in_progress",
              priority: "medium",
            },
          ]);
        }
        if (selectCall === 2) return createSelectChain([]);
        return createSelectChain([currentSummary]);
      }),
    };

    mockUpsertIssueDocument
      .mockRejectedValueOnce(conflict("Document key already exists on this issue", { key: "continuation-summary" }))
      .mockResolvedValueOnce({
        document: {
          ...currentSummary,
          body: "# Updated Continuation Summary",
          latestRevisionId: "revision-updated",
          latestRevisionNumber: 2,
        },
      });

    const document = await refreshIssueContinuationSummary({
      db: db as never,
      issueId: "issue-1",
      run: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        error: null,
        resultJson: { summary: "Completed the latest step." },
        finishedAt: new Date("2026-05-24T12:01:00.000Z"),
      },
      agent: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Codex",
        adapterType: "codex_local",
      },
    });

    expect(document?.latestRevisionId).toBe("revision-updated");
    expect(mockUpsertIssueDocument).toHaveBeenCalledTimes(2);
    expect(mockUpsertIssueDocument).toHaveBeenLastCalledWith(expect.objectContaining({
      key: "continuation-summary",
      baseRevisionId: "revision-existing",
    }));
  });

  it("retries when the create race surfaces as a wrapped Postgres unique violation", async () => {
    const { refreshIssueContinuationSummary } = await import("../services/issue-continuation-summary.js");
    let selectCall = 0;
    const currentSummary = {
      title: "Continuation Summary",
      body: "# Existing Continuation Summary",
      latestRevisionId: "revision-existing",
      latestRevisionNumber: 1,
      updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    };
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return createSelectChain([
            {
              id: "issue-1",
              identifier: "PAP-1",
              title: "Race the continuation summary",
              description: "Keep the issue resumable.",
              status: "in_progress",
              priority: "medium",
            },
          ]);
        }
        if (selectCall === 2) return createSelectChain([]);
        return createSelectChain([currentSummary]);
      }),
    };

    mockUpsertIssueDocument
      .mockRejectedValueOnce(wrappedUniqueViolation())
      .mockResolvedValueOnce({
        document: {
          ...currentSummary,
          body: "# Updated Continuation Summary",
          latestRevisionId: "revision-updated",
          latestRevisionNumber: 2,
        },
      });

    const document = await refreshIssueContinuationSummary({
      db: db as never,
      issueId: "issue-1",
      run: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        error: null,
        resultJson: { summary: "Completed the latest step." },
        finishedAt: new Date("2026-05-24T12:01:00.000Z"),
      },
      agent: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Codex",
        adapterType: "codex_local",
      },
    });

    expect(document?.latestRevisionId).toBe("revision-updated");
    expect(mockUpsertIssueDocument).toHaveBeenCalledTimes(2);
    expect(mockUpsertIssueDocument).toHaveBeenLastCalledWith(expect.objectContaining({
      key: "continuation-summary",
      baseRevisionId: "revision-existing",
    }));
  });
});
