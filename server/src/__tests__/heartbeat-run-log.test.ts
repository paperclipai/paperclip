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
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });
});

describe("compactRunLogChunk with long base64 commands", () => {
  it("redacts a tool call that writes base64 of source text without stalling", () => {
    const typescriptSource = "export const limit = 65536;\nexport function keep(value: string) {\n  return value.slice(0, limit);\n}\n";
    const blob = Buffer.from(typescriptSource.repeat(1_000)).toString("base64").slice(0, 48 * 1024);
    expect(blob).toMatch(/^[A-Za-z0-9]+$/);
    const command = `printf '%s' '${blob}' | base64 -d > src/keep.ts && echo '{"GITHUB_TOKEN":"tool-call-secret"}'`;
    const chunk = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { command } }] } })}\n`;

    const startedAt = performance.now();
    const compacted = compactRunLogChunk(chunk);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(compacted).toContain(blob);
    expect(compacted).not.toContain("tool-call-secret");
    expect(compacted).toContain("***REDACTED***");
  });
});
