import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_AFTER_ANCHOR,
  SETUP_TOKEN_BEFORE_ANCHOR,
  SETUP_TOKEN_PREFIX,
  SETUP_TOKEN_PROMPT,
  SETUP_TOKEN_URL_PATH,
  SETUP_TOKEN_URL_QUERY_KEYS,
  parseSetupTokenCredential,
  parseSetupTokenPrompt,
} from "./setup-token-parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

// A well-formed authorization URL that carries the exact query keys of the
// contract. The values are synthetic; the fixture redacts the real values.
const VALID_URL =
  "https://claude.com/cai/oauth/authorize" +
  "?client_id=cid-000" +
  "&code=redacted" +
  "&code_challenge=chal-000" +
  "&code_challenge_method=S256" +
  "&redirect_uri=https%3A%2F%2Fclaude.com%2Fcallback" +
  "&response_type=code" +
  "&scope=user%3Ainference" +
  "&state=state-000";

// The URL preamble line and the browser-code prompt line, exactly as the
// fixture records them.
const PREAMBLE_LINE = "Browser didn’t open? Use the url below to sign in (c to copy)";
const PROMPT_LINE = "Paste code here if prompted >";

// Builds a complete, plain-text login output around a URL.
function completeOutput(url: string): string {
  return [
    "Welcome to Claude Code v2.1.205",
    "Opening browser to sign in…",
    PREAMBLE_LINE,
    url,
    PROMPT_LINE,
  ].join("\n");
}

// Wraps a URL in an OSC 8 hyperlink. The URI field carries the true URL. The
// display text is a wrapped, truncated form, so the test proves the parser reads
// the URI and not the display text.
function osc8Hyperlink(url: string, display: string): string {
  const ESC = "\x1b";
  return `${ESC}]8;;${url}${ESC}\\${display}${ESC}]8;;${ESC}\\`;
}

describe("parseSetupTokenPrompt", () => {
  it("returns the exact URL and prompt from a complete output", () => {
    const result = parseSetupTokenPrompt(completeOutput(VALID_URL));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(VALID_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("returns the URL when the output arrives split across chunks", () => {
    // The streaming caller accumulates chunks and re-parses the whole buffer.
    // The first chunk holds a partial URL, so the parser returns null. The joined
    // buffer holds the whole prompt, so the parser returns the URL.
    const chunkA = ["Opening browser to sign in…", PREAMBLE_LINE, "https://claude.com/cai/oauth/aut"].join(
      "\n",
    );
    const chunkB = ["horize?client_id=cid-000&code=redacted&code_challenge=chal-000&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fclaude.com%2Fcallback&response_type=code&scope=user%3Ainference&state=state-000", PROMPT_LINE, ""].join(
      "\n",
    );
    expect(parseSetupTokenPrompt(chunkA)).toBeNull();
    const joined = parseSetupTokenPrompt(chunkA + chunkB);
    expect(joined).not.toBeNull();
    expect(joined?.url).toBe(VALID_URL);
    expect(joined?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("reads the URL through ANSI and OSC 8 sequences with wrapped display text", () => {
    const cyan = "\x1b[36m";
    const reset = "\x1b[0m";
    // The display text wraps across two lines and truncates the URL. The parser
    // must ignore it and read the URI field of the hyperlink.
    const wrappedDisplay = "https://claude.com/cai/oauth/aut\nhorize?client_id=cid-000&code=…";
    const text = [
      `${cyan}Opening browser to sign in…${reset}`,
      PREAMBLE_LINE,
      `${cyan}${osc8Hyperlink(VALID_URL, wrappedDisplay)}${reset}`,
      `${cyan}${PROMPT_LINE}${reset}`,
    ].join("\n");
    const result = parseSetupTokenPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(VALID_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("returns null for a wrong origin", () => {
    const badOrigin = VALID_URL.replace("https://claude.com", "https://claude.example.com");
    expect(parseSetupTokenPrompt(completeOutput(badOrigin))).toBeNull();
  });

  it("returns null for a wrong path", () => {
    const badPath = VALID_URL.replace(SETUP_TOKEN_URL_PATH, "/cai/oauth/authorise");
    expect(parseSetupTokenPrompt(completeOutput(badPath))).toBeNull();
  });

  it("returns null for a missing query key", () => {
    const missingKey = VALID_URL.replace("&state=state-000", "");
    expect(parseSetupTokenPrompt(completeOutput(missingKey))).toBeNull();
  });

  it("returns null for an extra query key", () => {
    const extraKey = `${VALID_URL}&extra=1`;
    expect(parseSetupTokenPrompt(completeOutput(extraKey))).toBeNull();
  });

  it("returns null for a URL with a fragment", () => {
    const withFragment = `${VALID_URL}#section`;
    expect(parseSetupTokenPrompt(completeOutput(withFragment))).toBeNull();
  });

  it("returns null when a code-like value sits on the line after the URL", () => {
    // The line right after the URL must hold the browser-code prompt. A code-like
    // value on that line cannot bind, so the parser returns null.
    const text = [PREAMBLE_LINE, VALID_URL, "ABCD-EFGHJ", PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null when the URL is absent from the login context", () => {
    const text = [PREAMBLE_LINE, "no url here", PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null when the login preamble is absent", () => {
    const text = ["Some unrelated output", VALID_URL, PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null for an API-key-shaped URL value", () => {
    const withKey = VALID_URL.replace("code=redacted", "code=sk-ant-oat01-abc123");
    expect(parseSetupTokenPrompt(completeOutput(withKey))).toBeNull();
  });

  it("returns null for a non-string input", () => {
    expect(parseSetupTokenPrompt(undefined as unknown as string)).toBeNull();
    expect(parseSetupTokenPrompt("")).toBeNull();
  });

  it("keeps its contract in sync with the characterization fixture", () => {
    // The fixture documents the prompt text, the URL path, and the query keys.
    // This test fails if the parser contract drifts from the fixture.
    const fixture = readFixture("setup-token.md");
    expect(fixture).toContain(SETUP_TOKEN_PROMPT);
    expect(fixture).toContain(SETUP_TOKEN_URL_PATH);
    for (const key of SETUP_TOKEN_URL_QUERY_KEYS) {
      expect(fixture).toContain(`\`${key}\``);
    }
  });
});

// A synthetic OAuth token. The terminal wraps a real token across two physical
// lines at the pseudo-terminal width. The two fragments join with no separator
// to form the full token. The tail carries a `-` and a `_`, so the test proves
// the parser does not stop at the first hyphen. No real token is present.
const TOKEN_FRAGMENT_A = `${SETUP_TOKEN_PREFIX}AAAABBBBCCCCDDDDEEEE1111`;
const TOKEN_FRAGMENT_B = "2222FFFFGGGG_HHHH-IIII";
const FULL_TOKEN = `${TOKEN_FRAGMENT_A}${TOKEN_FRAGMENT_B}`;

// Builds the success screen around a token body. The body holds the token
// fragment lines, already split the way the terminal wraps them.
function successScreen(body: string[]): string {
  return [
    "✓ Long-lived authentication token created successfully!",
    "",
    SETUP_TOKEN_BEFORE_ANCHOR,
    "",
    ...body,
    "",
    SETUP_TOKEN_AFTER_ANCHOR,
    "",
    "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>",
  ].join("\n");
}

describe("parseSetupTokenCredential", () => {
  it("returns the de-wrapped token from the exact success record once", () => {
    const text = successScreen([TOKEN_FRAGMENT_A, TOKEN_FRAGMENT_B]);
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("returns a single-line token from the success record", () => {
    const text = successScreen([FULL_TOKEN]);
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("reads the token through ANSI color sequences", () => {
    const cyan = "\x1b[36m";
    const reset = "\x1b[0m";
    const text = successScreen([`${cyan}${TOKEN_FRAGMENT_A}`, `${TOKEN_FRAGMENT_B}${reset}`]);
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("returns null for a token-shaped value before submit", () => {
    // The prompt screen holds a token-shaped value but no success anchors. The
    // parser fails closed, so an early value never delivers.
    const text = [
      "Browser didn’t open? Use the url below to sign in (c to copy)",
      VALID_URL,
      "Paste code here if prompted >",
      FULL_TOKEN,
    ].join("\n");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a token-shaped value in retry or error text", () => {
    const text = [
      "Invalid code. Please try again.",
      `error context ${FULL_TOKEN} more context`,
      "Paste code here if prompted >",
    ].join("\n");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a token-shaped value after cancellation", () => {
    const text = ["Login cancelled.", FULL_TOKEN, "Goodbye."].join("\n");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null when extra text sits on the token line", () => {
    // The token line holds the token and extra prose. The parser reads only a
    // token fragment on each line, so it fails closed.
    const text = successScreen([`${FULL_TOKEN} keep this secret`]);
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null when a prose line sits between the anchors", () => {
    const text = successScreen([TOKEN_FRAGMENT_A, "a stray note", TOKEN_FRAGMENT_B]);
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a duplicate success block", () => {
    const text = `${successScreen([FULL_TOKEN])}\n${successScreen([FULL_TOKEN])}`;
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null when the after-anchor comes before the before-anchor", () => {
    const text = [
      SETUP_TOKEN_AFTER_ANCHOR,
      "",
      FULL_TOKEN,
      "",
      SETUP_TOKEN_BEFORE_ANCHOR,
    ].join("\n");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null when the before-anchor is absent", () => {
    const text = [FULL_TOKEN, "", SETUP_TOKEN_AFTER_ANCHOR].join("\n");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null when the after-anchor is absent", () => {
    const text = [SETUP_TOKEN_BEFORE_ANCHOR, "", FULL_TOKEN].join("\n");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a wrong token prefix between the anchors", () => {
    const text = successScreen(["sk-ant-api03-AAAABBBBCCCCDDDDEEEE1111"]);
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a bare prefix with no opaque tail", () => {
    const text = successScreen([SETUP_TOKEN_PREFIX]);
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a non-string input", () => {
    expect(parseSetupTokenCredential(undefined as unknown as string)).toBeNull();
    expect(parseSetupTokenCredential("")).toBeNull();
  });

  it("keeps its token contract in sync with the success fixture", () => {
    // The success fixture records the anchor lines and the token prefix. This
    // test fails if the token parser contract drifts from the fixture.
    const fixture = readFixture("setup-token-success.md");
    expect(fixture).toContain(SETUP_TOKEN_BEFORE_ANCHOR);
    expect(fixture).toContain(SETUP_TOKEN_AFTER_ANCHOR);
    expect(fixture).toContain(SETUP_TOKEN_PREFIX);
  });
});
