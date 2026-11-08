import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { documentService, extractLegacyPlanBody } from "../services/documents.js";

describe("extractLegacyPlanBody", () => {
  it("returns null when no plan block exists", () => {
    expect(extractLegacyPlanBody("hello world")).toBeNull();
  });

  it("extracts plan body from legacy issue descriptions", () => {
    expect(
      extractLegacyPlanBody(`
intro

<plan>

# Plan

- one
- two

</plan>
      `),
    ).toBe("# Plan\n\n- one\n- two");
  });

  it("ignores empty plan blocks", () => {
    expect(extractLegacyPlanBody("<plan>   </plan>")).toBeNull();
  });
});


describe("document creation conflicts", () => {
  function serviceWithTransactionError(error: Error) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "issue-1", companyId: "company-1" }]),
        }),
      }),
      transaction: vi.fn().mockRejectedValue(error),
    };
    return documentService(db as unknown as Db);
  }

  const input = { issueId: "issue-1", key: "plan", format: "markdown", body: "# Plan" };

  it("returns a retryable conflict for a Drizzle-wrapped concurrent insert", async () => {
    const error = new Error("Failed query: insert into issue_documents", {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "issue_documents_company_issue_key_uq",
      }),
    });
    await expect(serviceWithTransactionError(error).upsertIssueDocument(input)).rejects.toMatchObject({
      status: 409,
      message: "Document key already exists on this issue",
      details: { key: "plan" },
    });
  });

  it.each([
    { code: "23503", constraint_name: "issue_documents_issue_id_issues_id_fk" },
    { code: "23505", constraint_name: "document_revisions_document_revision_uq" },
    { code: "23505", constraint_name: "issue_documents_document_uq" },
  ])("preserves unrelated database failures ($constraint_name)", async (cause) => {
    const error = new Error("Failed query", { cause });
    await expect(serviceWithTransactionError(error).upsertIssueDocument(input)).rejects.toBe(error);
  });
});
