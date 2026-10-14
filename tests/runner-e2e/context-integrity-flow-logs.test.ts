import { describe, expect, it, vi } from "vitest";
import { readContextIntegrityRunLog } from "./context-integrity-flow.js";

function apiFor(response: { status: () => number; ok: () => boolean; json?: () => Promise<unknown> }) {
  return { request: { get: vi.fn().mockResolvedValue(response) } } as any;
}

describe("context-integrity run log evidence", () => {
  it("retains an available log response", async () => {
    const api = apiFor({
      status: () => 200,
      ok: () => true,
      json: async () => ({ content: "provider output" }),
    });
    await expect(readContextIntegrityRunLog(api, "run-1")).resolves.toEqual({
      status: "available",
      content: { content: "provider output" },
    });
    expect(api.request.get).toHaveBeenCalledWith(
      "/api/heartbeat-runs/run-1/log?limitBytes=1048576",
    );
  });

  it("records a missing log as an explicit optional diagnostic", async () => {
    const api = apiFor({ status: () => 404, ok: () => false });
    await expect(readContextIntegrityRunLog(api, "run-before-log")).resolves.toEqual({
      status: "unavailable",
      reason: "not_found",
      statusCode: 404,
    });
  });

  it.each([401, 403, 500])("does not hide an HTTP %s log failure", async (status) => {
    const api = apiFor({ status: () => status, ok: () => false });
    await expect(readContextIntegrityRunLog(api, "run-broken")).rejects.toThrow(
      `Run run-broken log returned ${status}`,
    );
  });
});
