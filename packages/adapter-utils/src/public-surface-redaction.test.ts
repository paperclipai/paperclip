import { describe, expect, it } from "vitest";
import { redactPublicSurfaceText } from "./public-surface-redaction.js";

describe("redactPublicSurfaceText", () => {
  it("redacts secret-shaped strings with stable public markers", () => {
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      'export PAPERCLIP_API_KEY="paperclip-shell-secret"',
      'payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}',
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const result = redactPublicSurfaceText(input, { appendMarker: false });

    expect(result.redacted).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(4);
    expect(result.text).toContain("[REDACTED:bearer-token:");
    expect(result.text).toContain("[REDACTED:secret:");
    expect(result.text).not.toContain("live-bearer-token-value");
    expect(result.text).not.toContain("paperclip-shell-secret");
    expect(result.text).not.toContain("paperclip-json-secret");
    expect(result.text).not.toContain("paperclip-flag-secret");
  });
});
