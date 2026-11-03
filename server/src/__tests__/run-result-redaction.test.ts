import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRunResultSecrets } from "../services/run-result-redaction.js";

const GH = `gho_${"A1b2C3d4E5".repeat(4)}`;
const SK = `sk-${"abcDEF123456".repeat(2)}`;
const PAT = `github_pat_${"Ab1Cd2Ef3G".repeat(5)}`;

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

  it("masks fine-grained GitHub PATs", () => {
    const out = redactRunResultSecrets({ stdout: `export GH=${PAT}` });
    expect(JSON.stringify(out)).not.toContain(PAT);
  });

  it("masks string values under credential-named keys and keeps numeric usage fields", () => {
    const out = redactRunResultSecrets({ accessToken: "opaque-host-credential-123456", usage: { inputTokens: 12 }, nextPageToken: "abcdefghijk" });
    expect(out.accessToken).toBe(REDACTED_EVENT_VALUE);
    expect(out.nextPageToken).toBe(REDACTED_EVENT_VALUE);
    expect(out.usage.inputTokens).toBe(12);
  });

  it("stays fast on long runs without whitespace and still masks tokens inside them", () => {
    const blob = "A".repeat(500_000);
    const input = { stdout: `start ${blob}${GH}${blob}.log end GITHUB_TOKEN=${GH}` };
    const started = performance.now();
    const out = redactRunResultSecrets(input);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(out.stdout).not.toContain(GH);
    expect(out.stdout.startsWith("start ")).toBe(true);
  });

  it("keeps an own __proto__ key as data", () => {
    const input = JSON.parse(`{"__proto__":{"x":1},"stdout":"token ${GH}"}`);
    const out = redactRunResultSecrets(input);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.stdout).not.toContain(GH);
  });
  it.each([
    JSON.stringify({ status: "passed", data: "A".repeat(1100) }),
    `https://example.invalid/auth-report?data=${"A".repeat(1100)}`,
    `token-count=${"A".repeat(1100)}`,
  ])("preserves long output without credential patterns (%s)", stdout => {
    const input = { stdout };
    expect(redactRunResultSecrets(input)).toBe(input);
  });
  it.each(["", "\u0000", "\u00000\u0000"])("redacts arbitrary credentials beside long output and NUL bytes (%j)", nul => {
    const secret = "opaque-host-credential-123456";
    const padding = "A".repeat(1100);
    for (const stdout of [
      `${nul}{"padding":"${padding}","accessToken":"${secret}"}`,
      `${padding}${nul} Authorization: Bearer ${secret}`,
      `${padding} ${nul}{"accessToken":"${secret}"}`,
      `password=${padding}`,
    ]) {
      const out = redactRunResultSecrets({ stdout });
      expect(out.stdout).not.toContain(secret);
      expect(out.stdout).toContain(REDACTED_EVENT_VALUE);
      if (stdout.startsWith("password=")) expect(out.stdout).not.toContain(padding);
    }
  });

});
