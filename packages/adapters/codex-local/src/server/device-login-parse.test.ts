import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDeviceLoginPrompt } from "./device-login-parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

const EXACT_URL = "https://auth.openai.com/codex/device";

describe("parseDeviceLoginPrompt", () => {
  it("parse_returns_url_and_code_from_sample", () => {
    const result = parseDeviceLoginPrompt(readFixture("device-login-sample.txt"));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(EXACT_URL);
    // The committed sample keeps the capture-time redaction of the code. The
    // parser extracts the four-hyphen-five structure without a real secret.
    expect(result?.code).toBe("????-?????");
  });

  it("parse_returns_null_when_prompt_absent", () => {
    const text = "Some unrelated log line\nNothing to see here\n";
    expect(parseDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_url_with_query_or_fragment", () => {
    const withQuery = [
      "Open this link",
      "https://auth.openai.com/codex/device?foo=bar",
      "ABCD-EFGHJ",
    ].join("\n");
    const withFragment = [
      "Open this link",
      "https://auth.openai.com/codex/device#section",
      "ABCD-EFGHJ",
    ].join("\n");
    expect(parseDeviceLoginPrompt(withQuery)).toBeNull();
    expect(parseDeviceLoginPrompt(withFragment)).toBeNull();
  });

  it("parse_returns_null_for_wrong_origin_or_path", () => {
    const wrongOrigin = [
      "Open this link",
      "https://auth.example.com/codex/device",
      "ABCD-EFGHJ",
    ].join("\n");
    const wrongPath = [
      "Open this link",
      "https://auth.openai.com/codex/device/extra",
      "ABCD-EFGHJ",
    ].join("\n");
    const httpScheme = [
      "Open this link",
      "http://auth.openai.com/codex/device",
      "ABCD-EFGHJ",
    ].join("\n");
    expect(parseDeviceLoginPrompt(wrongOrigin)).toBeNull();
    expect(parseDeviceLoginPrompt(wrongPath)).toBeNull();
    expect(parseDeviceLoginPrompt(httpScheme)).toBeNull();
  });

  it("parse_returns_null_for_malformed_short_code", () => {
    const shortCode = [EXACT_URL, "ABC-EFGHJ"].join("\n"); // 3 then 5
    const longCode = [EXACT_URL, "ABCDE-EFGHJ"].join("\n"); // 5 then 5
    const noHyphen = [EXACT_URL, "ABCDEFGHJ"].join("\n");
    const noCode = [EXACT_URL, "no code on this line"].join("\n");
    expect(parseDeviceLoginPrompt(shortCode)).toBeNull();
    expect(parseDeviceLoginPrompt(longCode)).toBeNull();
    expect(parseDeviceLoginPrompt(noHyphen)).toBeNull();
    expect(parseDeviceLoginPrompt(noCode)).toBeNull();
  });

  it("parse_ignores_token_like_text", () => {
    // Token-like noise without the exact device URL must not yield a prompt.
    const text = [
      "tokens received",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      "sk-proj-ABCD1234ABCD1234ABCD1234",
      "ABCD-EFGHJ",
    ].join("\n");
    expect(parseDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_edge_sample", () => {
    // The grounded edge row carries a URL, but a wrong path and a wrong origin
    // segment, so the parser rejects it.
    expect(parseDeviceLoginPrompt(readFixture("device-login-edge.txt"))).toBeNull();
  });

  it("keeps the url and the code out of a thrown error", () => {
    // A non-string input is a programming error, but the message must never
    // carry secret-bearing input. The parser returns null instead of throwing.
    // @ts-expect-error deliberate wrong type
    expect(parseDeviceLoginPrompt(undefined)).toBeNull();
    // @ts-expect-error deliberate wrong type
    expect(parseDeviceLoginPrompt(12345)).toBeNull();
  });
});
