import { describe, expect, it } from "vitest";
import { readIngestOperationIssueId, uploadIssueAttachmentFile } from "../src/ui/issue-attachments.js";

describe("LLM Wiki issue attachment uploads", () => {
  it("reads the ingest operation issue id from the action result", () => {
    expect(readIngestOperationIssueId({
      operation: {
        issue: {
          id: "issue-1",
        },
      },
    })).toBe("issue-1");
  });

  it("rejects an ingest result that cannot identify the created issue", () => {
    expect(() => readIngestOperationIssueId({ operation: { issue: null } }))
      .toThrow("did not return an issue id");
  });

  it("uploads the original file to the created ingest task", async () => {
    const file = new File(["hello"], "source notes.md", { type: "text/markdown" });
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl = async (input: string, init: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ id: "attachment-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(uploadIssueAttachmentFile({
      companyId: "company 1",
      issueId: "issue/1",
      file,
      fetchImpl,
    })).resolves.toEqual({ id: "attachment-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/api/companies/company%201/issues/issue%2F1/attachments");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("include");
    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBe(file);
  });

  it("surfaces server upload errors", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "Attachment exceeds 10 bytes" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });

    await expect(uploadIssueAttachmentFile({
      companyId: "company-1",
      issueId: "issue-1",
      file: new File(["hello"], "source.txt"),
      fetchImpl,
    })).rejects.toThrow("Attachment exceeds 10 bytes");
  });
});
