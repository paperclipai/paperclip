import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGrokDeviceLoginPrompt } from "./device-login-parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

const PREAMBLE = "Confirm this code in your browser:";
const ORIGIN = "https://accounts.x.ai";
const PATH = "/oauth2/device";

function buildPrompt(code: string, urlCode: string = code): string {
  return [
    "",
    "To sign in, open this URL in your browser:",
    "",
    `  ${ORIGIN}${PATH}?user_code=${urlCode}`,
    "",
    PREAMBLE,
    "",
    `  ${code}`,
    "",
  ].join("\n");
}

describe("parseGrokDeviceLoginPrompt", () => {
  it("parse_returns_url_and_code_from_the_captured_fixture", () => {
    const result = parseGrokDeviceLoginPrompt(readFixture("device-login-prompt.txt"));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(`${ORIGIN}${PATH}?user_code=XXXX-XXXX`);
    expect(result?.code).toBe("XXXX-XXXX");
  });

  it("parse_returns_null_when_the_url_code_differs_from_the_standalone_code", () => {
    const text = buildPrompt("ABCD-EFGH", "WXYZ-1234");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_a_query_that_repeats_user_code", () => {
    const text = [
      "To sign in, open this URL in your browser:",
      `  ${ORIGIN}${PATH}?user_code=ABCD-EFGH&user_code=ABCD-EFGH`,
      PREAMBLE,
      "  ABCD-EFGH",
    ].join("\n");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_a_query_that_adds_a_second_key", () => {
    const text = [
      "To sign in, open this URL in your browser:",
      `  ${ORIGIN}${PATH}?user_code=ABCD-EFGH&session=1`,
      PREAMBLE,
      "  ABCD-EFGH",
    ].join("\n");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_a_wrong_origin", () => {
    const text = [
      "To sign in, open this URL in your browser:",
      `  https://accounts.example.com${PATH}?user_code=ABCD-EFGH`,
      PREAMBLE,
      "  ABCD-EFGH",
    ].join("\n");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_a_wrong_path", () => {
    const text = [
      "To sign in, open this URL in your browser:",
      `  ${ORIGIN}/oauth2/device/extra?user_code=ABCD-EFGH`,
      PREAMBLE,
      "  ABCD-EFGH",
    ].join("\n");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_a_url_with_a_fragment", () => {
    const text = [
      "To sign in, open this URL in your browser:",
      `  ${ORIGIN}${PATH}?user_code=ABCD-EFGH#section`,
      PREAMBLE,
      "  ABCD-EFGH",
    ].join("\n");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_for_a_five_character_code_group", () => {
    const text = [
      "To sign in, open this URL in your browser:",
      `  ${ORIGIN}${PATH}?user_code=ABCDE-FGHIJ`,
      PREAMBLE,
      "  ABCDE-FGHIJ",
    ].join("\n");
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_when_the_prompt_is_absent", () => {
    const text = "Some unrelated log line\nNothing to see here\n";
    expect(parseGrokDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_reads_the_prompt_from_output_that_arrives_in_two_chunks", () => {
    const full = buildPrompt("ABCD-EFGH");
    const splitAt = Math.floor(full.length / 2);
    const combined = full.slice(0, splitAt) + full.slice(splitAt);
    const result = parseGrokDeviceLoginPrompt(combined);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("ABCD-EFGH");
  });

  it("parse_reads_the_prompt_when_the_url_and_the_code_carry_ansi_sequences", () => {
    const cyan = "\x1b[36m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";
    const text = [
      "To sign in, open this URL in your browser:",
      `  ${cyan}${ORIGIN}${PATH}?user_code=ABCD-EFGH${reset}`,
      PREAMBLE,
      `  ${bold}ABCD-EFGH${reset}`,
    ].join("\n");
    const result = parseGrokDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(`${ORIGIN}${PATH}?user_code=ABCD-EFGH`);
    expect(result?.code).toBe("ABCD-EFGH");
  });

  it("parse_reads_the_prompt_from_pipe_output_that_ends_every_line_with_a_line_feed_only", () => {
    // The captured pipe transport ends every line with `\x0a` only, with no
    // `\x0d`. The fixture already exercises this; this test pins the same
    // shape with the exact captured line order and the two-space indent.
    const text =
      "\n" +
      "To sign in, open this URL in your browser:\n" +
      "\n" +
      `  ${ORIGIN}${PATH}?user_code=ABCD-EFGH\n` +
      "\n" +
      `${PREAMBLE}\n` +
      "\n" +
      "  ABCD-EFGH\n" +
      "\n" +
      "\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m\n" +
      "\n" +
      "Waiting for authorization...\n";
    const result = parseGrokDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(`${ORIGIN}${PATH}?user_code=ABCD-EFGH`);
    expect(result?.code).toBe("ABCD-EFGH");
  });

  it("keeps the url and the code out of a thrown error", () => {
    // @ts-expect-error deliberate wrong type
    expect(parseGrokDeviceLoginPrompt(undefined)).toBeNull();
    // @ts-expect-error deliberate wrong type
    expect(parseGrokDeviceLoginPrompt(12345)).toBeNull();
  });
});
