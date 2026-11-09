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

  it("parse_returns_url_and_code_from_ansi_colored_output", () => {
    // Codex CLI 0.128.0 and later add ANSI color (SGR) sequences around the URL
    // and the code. A live sandbox run confirmed this format. The parser removes
    // the Control Sequence Introducer sequences and reads the tokens the same as
    // plain output.
    const cyan = "\x1b[36m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";
    const text = [
      "1. Open this link in your browser and sign in to your account",
      `${cyan}${EXACT_URL}${reset}`,
      "2. Enter this one-time code (expires in 15 minutes)",
      `${bold}ABCD-EFGHJ${reset}`,
    ].join("\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(EXACT_URL);
    expect(result?.code).toBe("ABCD-EFGHJ");
  });

  it("parse_returns_url_and_code_from_carriage_return_line_endings", () => {
    // A pseudo-terminal ends each line with a carriage return and a line feed.
    // The carriage return is whitespace, so the URL token stops before it, and the
    // code line trims it. The parser reads the tokens the same as line-feed output.
    const text = [
      "1. Open this link in your browser and sign in to your account",
      EXACT_URL,
      "2. Enter this one-time code (expires in 15 minutes)",
      "ABCD-EFGHJ",
    ].join("\r\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(EXACT_URL);
    expect(result?.code).toBe("ABCD-EFGHJ");
  });

  it("parse_returns_url_and_code_with_a_terminal_title_osc_sequence", () => {
    // A pseudo-terminal can emit an Operating System Command (OSC) title sequence
    // in the stream. The device-auth prompt still prints the URL and the code as
    // plain standalone tokens on their own lines. The OSC title sequence carries no
    // URL token, so it does not shift the URL or the code, and the parser reads
    // both tokens.
    const osc = "\x1b]0;Codex\x07";
    const text = [
      `${osc}1. Open this link in your browser and sign in to your account`,
      EXACT_URL,
      "2. Enter this one-time code (expires in 15 minutes)",
      "ABCD-EFGHJ",
    ].join("\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(EXACT_URL);
    expect(result?.code).toBe("ABCD-EFGHJ");
  });

  it("parse_returns_url_and_code_from_a_merged_raw_pseudo_terminal_frame", () => {
    // One buffer holds the whole prompt as a real pseudo-terminal emits it: a
    // leading title Operating System Command (OSC) sequence, color Control
    // Sequence Introducer (CSI) sequences around the URL and the code, and
    // carriage-return line endings. The parser removes the color sequences and
    // reads the plain tokens.
    const title = "\x1b]0;Codex login\x07";
    const cyan = "\x1b[36m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";
    const text =
      `${title}1. Open this link in your browser and sign in to your account\r\n` +
      `${cyan}${EXACT_URL}${reset}\r\n` +
      `2. Enter this one-time code (expires in 15 minutes)\r\n` +
      `${bold}ABCD-EFGHJ${reset}\r\n`;
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(EXACT_URL);
    expect(result?.code).toBe("ABCD-EFGHJ");
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

  it("parse_returns_the_printed_url_with_a_bare_trailing_fragment_marker", () => {
    // A printed URL that ends with a bare `#` carries an empty fragment. The
    // platform `URL` parser keeps the marker in its normalized form. The parser
    // returns that normalized form, not the fixed constant.
    const preamble = "2. Enter this one-time code (expires in 15 minutes)";
    const text = [`${EXACT_URL}#`, preamble, "ABCD-EFGHJ"].join("\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://auth.openai.com/codex/device#");
  });

  it("parse_returns_the_normalized_url_for_an_explicit_default_port_or_an_uppercase_host", () => {
    // The platform `URL` parser normalizes an explicit default port and an
    // uppercase host. The parser returns that normalized form.
    const preamble = "2. Enter this one-time code (expires in 15 minutes)";
    const withPort = [`${EXACT_URL.replace("auth.openai.com", "auth.openai.com:443")}`, preamble, "ABCD-EFGHJ"].join(
      "\n",
    );
    const withUppercaseHost = [
      `${EXACT_URL.replace("auth.openai.com", "AUTH.OPENAI.COM")}`,
      preamble,
      "ABCD-EFGHJ",
    ].join("\n");
    expect(parseDeviceLoginPrompt(withPort)?.url).toBe(EXACT_URL);
    expect(parseDeviceLoginPrompt(withUppercaseHost)?.url).toBe(EXACT_URL);
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
    // Each input carries the code preamble after the URL, so the test exercises
    // the code-structure check and not the preamble check.
    const preamble = "2. Enter this one-time code (expires in 15 minutes)";
    const shortCode = [EXACT_URL, preamble, "ABC-EFGHJ"].join("\n"); // 3 then 5
    const longCode = [EXACT_URL, preamble, "ABCDE-EFGHJ"].join("\n"); // 5 then 5
    const noHyphen = [EXACT_URL, preamble, "ABCDEFGHJ"].join("\n");
    const noCode = [EXACT_URL, preamble, "no code on this line"].join("\n");
    expect(parseDeviceLoginPrompt(shortCode)).toBeNull();
    expect(parseDeviceLoginPrompt(longCode)).toBeNull();
    expect(parseDeviceLoginPrompt(noHyphen)).toBeNull();
    expect(parseDeviceLoginPrompt(noCode)).toBeNull();
  });

  it("parse_binds_code_to_url_and_ignores_a_code_before_the_url", () => {
    // A code-shaped token appears before the URL. The parser reads the code only
    // after the URL, so it uses the code that follows the URL.
    const text = [
      "WXYZ-98765",
      "1. Open this link in your browser and sign in to your account",
      EXACT_URL,
      "2. Enter this one-time code (expires in 15 minutes)",
      "ABCD-EFGHJ",
    ].join("\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("ABCD-EFGHJ");
  });

  it("parse_returns_null_when_only_code_is_before_the_url", () => {
    // The only code-shaped token sits before the URL. No code follows the URL,
    // so the parser rejects the output instead of binding the earlier token.
    const text = ["WXYZ-98765", "Open this link", EXACT_URL].join("\n");
    expect(parseDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_when_code_is_far_after_the_url", () => {
    // A code-shaped token sits far below the URL, past the proximity window. The
    // parser does not bind a distant token to the URL.
    const filler = "unrelated log line\n".repeat(40);
    const text = [EXACT_URL, filler, "ABCD-EFGHJ"].join("\n");
    expect(parseDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_ignores_a_code_between_the_url_and_the_code_preamble", () => {
    // A code-shaped token sits after the URL but before the "one-time code"
    // preamble line. The parser anchors the code on the preamble, so it ignores
    // the earlier token and returns the real code after the preamble.
    const text = [
      "1. Open this link in your browser and sign in to your account",
      EXACT_URL,
      "session id WXYZ-98765 for this attempt",
      "2. Enter this one-time code (expires in 15 minutes)",
      "ABCD-EFGHJ",
    ].join("\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("ABCD-EFGHJ");
  });

  it("parse_ignores_a_code_that_shares_the_preamble_line", () => {
    // A code-shaped token shares the preamble line with the "one-time code"
    // phrase. The parser advances past the whole preamble line, so it ignores the
    // token on that line and returns the code from the dedicated code line below.
    const text = [
      EXACT_URL,
      "2. Enter this one-time code (ref WXYZ-98765, expires in 15 minutes)",
      "ABCD-EFGHJ",
    ].join("\n");
    const result = parseDeviceLoginPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("ABCD-EFGHJ");
  });

  it("parse_returns_null_when_a_noise_line_follows_the_preamble", () => {
    // A line that mixes a code-shaped token with other text sits right after the
    // preamble line. The parser reads the code only from a dedicated code line, so
    // it never surfaces the embedded token. It rejects the output instead. This
    // proves the parser binds the code to the prompt-code line and not to any
    // nearby code-shaped token.
    const text = [
      EXACT_URL,
      "2. Enter this one-time code (expires in 15 minutes)",
      "your session token is WXYZ-98765 here",
      "ABCD-EFGHJ",
    ].join("\n");
    expect(parseDeviceLoginPrompt(text)).toBeNull();
  });

  it("parse_returns_null_when_the_code_preamble_is_absent", () => {
    // A valid code follows the URL, but the "one-time code" preamble is absent.
    // The parser requires the preamble, so it rejects the output. This binds the
    // code to the prompt structure and not to a bare code-shaped token.
    const text = [
      "1. Open this link in your browser and sign in to your account",
      EXACT_URL,
      "ABCD-EFGHJ",
    ].join("\n");
    expect(parseDeviceLoginPrompt(text)).toBeNull();
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
