import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
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

describe("document write conflicts", () => {
  function failingService(error: Error) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "issue", companyId: "company" }]),
        }),
      }),
      transaction: vi.fn().mockRejectedValue(error),
    };
    return documentService(db as unknown as Db);
  }

  const input = { issueId: "issue", key: "review", format: "markdown", body: "Review" };

  it("reports a wrapped unique violation as a retryable document conflict", async () => {
    const driverError = Object.assign(new Error("duplicate key"), { code: "23505" });
    const queryError = new Error("Failed query: insert into issue_documents", { cause: driverError });

    await expect(failingService(queryError).upsertIssueDocument(input)).rejects.toMatchObject({
      status: 409,
      message: "Document key already exists on this issue",
    });
  });

  it("does not disguise other database errors as document conflicts", async () => {
    const driverError = Object.assign(new Error("connection unavailable"), { code: "08006" });
    const queryError = new Error("Failed query", { cause: driverError });

    await expect(failingService(queryError).upsertIssueDocument(input)).rejects.toBe(queryError);
  });
});
