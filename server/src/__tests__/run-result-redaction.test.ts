import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRunResultSecrets } from "../services/run-result-redaction.js";

// Synthetic, well-formed but fake credential shapes.
const GH = `gho_${"A1b2C3d4E5".repeat(4)}`;
const SK = `sk-${"abcDEF123456".repeat(2)}`;

describe("redactRunResultSecrets", () => {
  it("masks host-side tokens inside captured stdout and nested fields", () => {
    const input = {
      stdout: `auth ok\nGITHUB_TOKEN=${GH}\nremote: https://x-access-token:${GH}@example.invalid/repo.git\n`,
      summary: "done",
      nested: { lines: [`token ${GH}`, `key ${SK}`], note: "Authorization: Bearer abcdefghijklmnop" },
      exitCode: 0,
      ok: true,
      none: null,
    };
    const out = redactRunResultSecrets(input);
    const text = JSON.stringify(out);
    expect(text).not.toContain(GH);
    expect(text).not.toContain(SK);
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).toContain(REDACTED_EVENT_VALUE);
    expect(out.summary).toBe("done");
    expect(out.exitCode).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.none).toBeNull();
    expect(Object.keys(out)).toEqual(Object.keys(input));
  });

  it("returns the same object when nothing needs redaction", () => {
    const input = { stdout: "build passed in 12s", usage: { inputTokens: 10, outputTokens: 5 }, items: ["a", "b"] };
    expect(redactRunResultSecrets(input)).toBe(input);
  });

  it("does not rebuild non-plain objects", () => {
    const when = new Date(0);
    const input = { at: when };
    expect(redactRunResultSecrets(input).at).toBe(when);
  });
});
