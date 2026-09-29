import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { apiResponseReadingTask, gradeApiResponsePaging, readResponseProof, responseEvidenceCode, responseEvidenceDescription } from "./api-response-reading.js";

describe("large API response evidence fixture", () => {
  it("keeps evidence beyond both preview and inline limits and out of the assignment", () => {
    const source = responseEvidenceDescription("fixture");
    const code = responseEvidenceCode("fixture");
    expect(Buffer.byteLength(source)).toBeGreaterThan(24 * 1024);
    expect(source.indexOf(code)).toBeGreaterThan(24 * 1024);
    expect(apiResponseReadingTask.buildPrompt("fixture")).not.toContain(code);
    expect(apiResponseReadingTask.buildPrompt("fixture")).toContain("responseText.nextOffsetBytes");
  });
  it("downloads exact run-attributed proof bytes rather than trusting the agent's report", async () => {
    const bytes = Buffer.from("independent evidence\n");
    const proof = { id: "proof", issueId: "issue", originatingRunId: "run", originalFilename: "api-response-proof.txt", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const download = vi.fn().mockResolvedValue({ ok: () => true, body: async () => bytes });
    const get = vi.fn().mockResolvedValue([proof]);
    const api = { get, request: { get: download } } as unknown as RunnerApi;
    expect((await readResponseProof(api, "issue", "run")).content).toBe(bytes.toString());
    expect(download).toHaveBeenCalledWith("/api/attachments/proof/content?download=1");
    get.mockResolvedValue([{ ...proof, originatingRunId: "other" }]);
    await expect(readResponseProof(api, "issue", "run")).rejects.toThrow("observed 0");
    get.mockResolvedValue([proof, proof]);
    await expect(readResponseProof(api, "issue", "run")).rejects.toThrow("observed 2");
    get.mockResolvedValue([{ ...proof, sha256: "mismatch" }]);
    await expect(readResponseProof(api, "issue", "run")).rejects.toThrow("disagrees");
  });
});

describe("saved API response pagination oracle", () => {
  const sourceIssueId = "source-issue";
  const assetId = "source-asset";
  const bytes = Buffer.from(JSON.stringify({ id: sourceIssueId, description: "synthetic padding ".repeat(2000) }));
  const operation = "GET /api/assets/{assetId}/content";
  const event = (eventType: string, payload: unknown) => ({ eventType, payload: { prpEvent: { payload } } });
  const call = (id: string, input: unknown, result: unknown, status = "completed") => [
    event("item.started", { item: { id, type: "tool_use", name: "call_api", input } }),
    event("item.completed", { item: { id, type: "tool_result", tool_use_id: id, result } }),
    event("tool.execution.completed", { name: "call_api", executionId: id, status }),
  ];
  const source = () => call("source-read", { operationId: "GET /api/issues/{id}", pathParams: { id: sourceIssueId } }, {
    ok: true, status: 200, apiOperationId: "GET /api/issues/{id}", artifact: {
      artifactId: assetId, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `/api/assets/${assetId}/content`,
    },
  });
  const page = (offset: number, id = `page-${offset}`, artifactId = assetId) => {
    const end = Math.min(offset + 8192, bytes.length);
    return call(id, { operationId: operation, pathParams: { assetId: artifactId }, responseText: { offsetBytes: offset, limitBytes: 8192 } }, {
      ok: true, status: 200, apiOperationId: operation, data: bytes.subarray(offset, end).toString(),
      responseText: { offsetBytes: offset, totalBytes: bytes.length, nextOffsetBytes: end === bytes.length ? null : end },
    });
  };
  const pages = () => Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, i) => page(i * 8192)).flat();
  it("accepts correlated source artifact pages through EOF, including a harmless identical retry", () => {
    expect(gradeApiResponsePaging([...source(), ...page(0, "retry"), ...pages()], sourceIssueId).passed).toBe(true);
  });
  it("rejects unrelated completed calls", () => {
    const unrelated = [1, 2, 3].flatMap(i => call(`unrelated-${i}`, { operationId: "GET /api/agents/me" }, { ok: true, status: 200 }));
    expect(gradeApiResponsePaging(unrelated, sourceIssueId).passed).toBe(false);
  });
  it("rejects repeating the first page without reaching EOF", () => {
    expect(gradeApiResponsePaging([...source(), ...page(0), ...page(0, "again"), ...page(0, "again-2")], sourceIssueId).passed).toBe(false);
  });
  it("rejects a gap even when the last page claims EOF", () => {
    expect(gradeApiResponsePaging([...source(), ...pages().filter((_e, i) => i < 3 || i >= 6)], sourceIssueId).passed).toBe(false);
  });
  it("rejects reading a different artifact", () => {
    const other = Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, i) => page(i * 8192, `other-${i}`, "other-asset")).flat();
    expect(gradeApiResponsePaging([...source(), ...other], sourceIssueId).passed).toBe(false);
  });
  it("requires the exact seeded source issue", () => {
    expect(gradeApiResponsePaging([...source(), ...pages()], "other-issue").passed).toBe(false);
  });
  it("requires a matched successful completion for every page", () => {
    const incomplete = pages().filter(e => e.eventType !== "tool.execution.completed");
    expect(gradeApiResponsePaging([...source(), ...incomplete], sourceIssueId).passed).toBe(false);
  });
  it.each([
    ["requested offset", { offsetBytes: 1, totalBytes: bytes.length, nextOffsetBytes: 8192 }],
    ["next offset", { offsetBytes: 0, totalBytes: bytes.length, nextOffsetBytes: 8193 }],
    ["total size", { offsetBytes: 0, totalBytes: bytes.length + 1, nextOffsetBytes: 8192 }],
    ["premature EOF", { offsetBytes: 0, totalBytes: bytes.length, nextOffsetBytes: null }],
  ])("rejects mismatched %s metadata", (_label, responseText) => {
    const malformed = call("bad-page", {
      operationId: operation, pathParams: { assetId }, responseText: { offsetBytes: 0, limitBytes: 8192 },
    }, { ok: true, status: 206, apiOperationId: operation, data: bytes.subarray(0, 8192).toString(), responseText });
    expect(gradeApiResponsePaging([...source(), ...pages(), ...malformed], sourceIssueId).passed).toBe(false);
  });
  it("rejects contradictory duplicate bytes and a wrong source artifact digest", () => {
    const corrupt = call("corrupt-page", {
      operationId: operation, pathParams: { assetId }, responseText: { offsetBytes: 0, limitBytes: 8192 },
    }, {
      ok: true, status: 206, apiOperationId: operation, data: "x".repeat(8192),
      responseText: { offsetBytes: 0, totalBytes: bytes.length, nextOffsetBytes: 8192 },
    });
    expect(gradeApiResponsePaging([...source(), ...pages(), ...corrupt], sourceIssueId).passed).toBe(false);
    expect(gradeApiResponsePaging([...source(), ...corrupt, ...pages().slice(3)], sourceIssueId).passed).toBe(false);
  });
});
