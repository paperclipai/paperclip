import { describe, it, expect } from "vitest";
import { createRedactor } from "../../src/redaction.js";

describe("createRedactor", () => {
  it("redacts secret values that appear in input", () => {
    const r = createRedactor(["sk-abcdefgh1234", "ghs_xyzabc12345"]);
    expect(r.redact("ANTHROPIC_API_KEY=sk-abcdefgh1234")).toBe("ANTHROPIC_API_KEY=<redacted>");
    expect(r.redact("hello ghs_xyzabc12345 world")).toBe("hello <redacted> world");
  });

  it("ignores values shorter than 8 chars (avoids false positives)", () => {
    const r = createRedactor(["short"]);
    expect(r.redact("the short fox")).toBe("the short fox");
  });

  it("redacts longest-first so substrings inside larger secrets aren't masked first", () => {
    const r = createRedactor(["abcd1234", "abcd1234efgh"]);
    expect(r.redact("seen abcd1234efgh once")).toBe("seen <redacted> once");
  });

  it("filters undefined/null entries", () => {
    const r = createRedactor([undefined, null, "actualsecret123"]);
    expect(r.redact("actualsecret123 leaked")).toBe("<redacted> leaked");
  });
});
