import { describe, expect, it } from "vitest";
import { buildRunLogForbiddenValues, compactRunLogChunk } from "../services/heartbeat.js";

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

  it("redacts resolved secret env values from persisted run-log chunks while preserving normal output", () => {
    const forbiddenValue = "ful7589SyntheticPlainEnvValueNoTokenShape";
    const normalOutput = "normal output remains visible";
    const forbiddenValues = buildRunLogForbiddenValues(
      {
        SECRET_ENV: forbiddenValue,
        NORMAL_ENV: "normal-env-value",
      },
      new Set(["SECRET_ENV"]),
    );
    const chunk = [
      normalOutput,
      `bare=${forbiddenValue}`,
      `json={"value":"${forbiddenValue}"}`,
    ].join("\n");

    const compacted = compactRunLogChunk(chunk, 16_384, forbiddenValues);

    expect((compacted.match(new RegExp(forbiddenValue, "g")) ?? []).length).toBe(0);
    expect(compacted).toContain("***REDACTED***");
    expect(compacted).toContain(normalOutput);
    expect(compacted).not.toContain("normal-env-value");
  });
});
