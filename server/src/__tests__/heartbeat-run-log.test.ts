import { describe, expect, it } from "vitest";
import {
  compactRunLogChunk,
  redactAdapterExecutionResultSecrets,
} from "../services/heartbeat.js";

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

  it("redacts resolved secret literals even when their env key is not sensitive", () => {
    const canary = "canary-granted-runtime-value";
    const compacted = compactRunLogChunk(
      `GRANTED_VALUE=${canary}`,
      16_384,
      [canary],
    );

    expect(compacted).toBe("GRANTED_VALUE=***REDACTED***");
    expect(compacted).not.toContain(canary);
  });

  it("redacts partial tool output from every persisted adapter result field", () => {
    const runJwtCanary = "canary-run-jwt-value";
    const grantedCanary = "canary-granted-secret-value";
    const partialUpdate = JSON.stringify({
      type: "tool_execution_update",
      partialResult: {
        content: `PAPERCLIP_API_KEY=${runJwtCanary}\nGRANTED_VALUE=${grantedCanary}`,
      },
    });

    const redacted = redactAdapterExecutionResultSecrets(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `adapter failed: ${runJwtCanary}`,
        errorMeta: { partialUpdate },
        resultJson: { stdout: partialUpdate, nested: { grantedCanary } },
        summary: `summary: ${grantedCanary}`,
      },
      [runJwtCanary, grantedCanary],
    );
    const persisted = JSON.stringify(redacted);

    expect(persisted).toContain("***REDACTED***");
    expect(persisted).not.toContain(runJwtCanary);
    expect(persisted).not.toContain(grantedCanary);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `PAPERCLIP_AGENT_JWT_SECRET=paperclip-signing-canary`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("paperclip-signing-canary");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });
});
