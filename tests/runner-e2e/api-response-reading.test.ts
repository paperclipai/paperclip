import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { apiResponseReadingTask, readResponseProof, responseEvidenceCode, responseEvidenceDescription, successfulApiReadCount } from "./api-response-reading.js";

describe("large API response evidence fixture", () => {
  it("keeps evidence beyond both preview and inline limits and out of the assignment", () => {
    const source = responseEvidenceDescription("fixture");
    const code = responseEvidenceCode("fixture");
    expect(Buffer.byteLength(source)).toBeGreaterThan(24 * 1024);
    expect(source.indexOf(code)).toBeGreaterThan(24 * 1024);
    expect(apiResponseReadingTask.buildPrompt("fixture")).not.toContain(code);
    expect(apiResponseReadingTask.buildPrompt("fixture")).toContain("responseText.nextOffsetBytes");
  });
  it("counts only real completed API tool events, never narrative claims or missing evidence", () => {
    const event = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { name: "call_api", status: "completed" } } } };
    expect(successfulApiReadCount([event])).toBe(1);
    expect(successfulApiReadCount([])).toBe(0);
    expect(successfulApiReadCount([{ ...event, eventType: "item.delta" }, { ...event, payload: null }, { ...event, payload: { prpEvent: { payload: { name: "call_api", status: "failed" } } } }])).toBe(0);
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
