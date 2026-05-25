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

  it("redacts free-form value-based secret patterns from run-log chunks", () => {
    // Secrets that appear in raw stdout (e.g. an agent printing a token,
    // a curl trace, or a .env dump) without being wrapped in a JSON field
    // whose key matches the existing field-name regex. These bypass
    // redactSensitiveText and are caught by sanitizeRunLogText.
    const ghpToken = `ghp_${"a".repeat(36)}`;
    const ghPatToken = `github_pat_${"b".repeat(40)}`;
    const cfutToken = `cfut_${"c".repeat(30)}`;
    const whsecToken = `whsec_${"d".repeat(40)}`;
    const sntrysToken = `sntrys_${"e".repeat(40)}`;
    const skAntToken = `sk-ant-${"f".repeat(40)}`;

    const chunk = [
      `Cloning into 'repo'... using ${ghpToken}`,
      `PAT detected: ${ghPatToken}`,
      `wrangler config: ${cfutToken}`,
      `webhook signing secret: ${whsecToken}`,
      `sentry-cli auth: ${sntrysToken}`,
      `anthropic env: ANTHROPIC_API_KEY=${skAntToken}`,
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(ghpToken);
    expect(compacted).not.toContain(ghPatToken);
    expect(compacted).not.toContain(cfutToken);
    expect(compacted).not.toContain(whsecToken);
    expect(compacted).not.toContain(sntrysToken);
    expect(compacted).not.toContain(skAntToken);
    expect(compacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(compacted).toContain("[REDACTED_GITHUB_PAT]");
    expect(compacted).toContain("[REDACTED_CF_TOKEN]");
    expect(compacted).toContain("[REDACTED_WEBHOOK_SECRET]");
    expect(compacted).toContain("[REDACTED_SENTRY_TOKEN]");
    expect(compacted).toContain("[REDACTED_API_KEY]");
  });
});
