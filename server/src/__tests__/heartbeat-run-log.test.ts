import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

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
    expect(compacted).toContain("[valadrien-os truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts ValadrienOs credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export VALADRIEN_OS_API_KEY='valadrien-os-shell-secret'`,
      `payload {"VALADRIEN_OS_API_KEY":"valadrien-os-json-secret"}`,
      "--valadrien-os-api-key=valadrien-os-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("valadrien-os-shell-secret");
    expect(compacted).not.toContain("valadrien-os-json-secret");
    expect(compacted).not.toContain("valadrien-os-flag-secret");
  });
});
