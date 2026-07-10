import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { compactRunLogChunk, heartbeatService } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });
});

describe("heartbeat run log reads", () => {
  it("returns a pending empty payload when an existing run has no initialized log yet", async () => {
    const service = heartbeatService({} as Db);

    await expect(
      service.readLog({
        id: "run-pending-log",
        companyId: "company-1",
        logStore: null,
        logRef: null,
      }),
    ).resolves.toEqual({
      runId: "run-pending-log",
      store: null,
      logRef: null,
      content: "",
      pending: true,
    });
  });
});
