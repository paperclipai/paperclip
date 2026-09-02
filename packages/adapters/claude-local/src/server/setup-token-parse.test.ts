import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_AFTER_ANCHOR,
  SETUP_TOKEN_AUTH_URLS,
  SETUP_TOKEN_BEFORE_ANCHOR,
  SETUP_TOKEN_PREFIX,
  SETUP_TOKEN_PROMPT,
  SETUP_TOKEN_REDIRECT_URI,
  SETUP_TOKEN_URL_QUERY_KEYS,
  parseSetupTokenCredential,
  parseSetupTokenPrompt,
} from "./setup-token-parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

// The synthetic query values. Each value passes the value validators of the
// contract. No value is a real OAuth value.
const CLIENT_ID = "9d1c8f00-1a2b-3c4d-5e6f-708192a3b4c5";
const CODE = "ac_0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us";
const SCOPE = "org:create_api_key user:profile";

// The query of a well-formed authorization URL. The `redirect_uri` and the
// `scope` are percent-encoded the way the CLI emits them; the parser decodes and
// validates each value.
const QUERY = [
  `client_id=${CLIENT_ID}`,
  `code=${CODE}`,
  `code_challenge=${CODE_CHALLENGE}`,
  "code_challenge_method=S256",
  `redirect_uri=${encodeURIComponent(SETUP_TOKEN_REDIRECT_URI)}`,
  "response_type=code",
  `scope=${encodeURIComponent(SCOPE)}`,
  `state=${STATE}`,
].join("&");

// The two observed authorization URLs. `claude` 2.1.19 emits the `claude.ai`
// URL; `claude` 2.1.205 and 2.1.226 emit the `claude.com` URL.
const CLAUDE_AI_URL = `https://claude.ai/oauth/authorize?${QUERY}`;
const CLAUDE_COM_URL = `https://claude.com/cai/oauth/authorize?${QUERY}`;

// The default URL for the credential-parser regression tests below.
const VALID_URL = CLAUDE_COM_URL;

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

// Joins `words` with a Cursor Horizontal Absolute (CHA) sequence. The live
// Claude login UI lays out each word at an absolute column with a CHA sequence
// instead of a literal space, so this reproduces one Ink-rendered line. The
// column number does not matter to the parser, so this uses a fixed number. The
// parser must render each CHA sequence as a space to read the line.
function chaSpaced(words: string[]): string {
  return words.join("\x1b[9G");
}

// Wraps a string into physical lines of at most `width` characters, joined with
// a line feed and no space at the wrap. This reproduces the `claude` 2.1.19 hard
// line wrap of the plain-text authorization URL.
function hardWrap(text: string, width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    lines.push(text.slice(i, i + width));
  }
  return lines.join("\n");
}

describe("parseSetupTokenPrompt", () => {
  it("returns the exact claude.com URL and prompt from a complete output", () => {
    const result = parseSetupTokenPrompt(completeOutput(CLAUDE_COM_URL));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(CLAUDE_COM_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("returns the exact claude.ai URL and prompt from a complete output", () => {
    const result = parseSetupTokenPrompt(completeOutput(CLAUDE_AI_URL));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(CLAUDE_AI_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("reassembles the claude.ai URL from the 2.1.19 hard-wrapped plain-text form", () => {
    // `claude` 2.1.19 emits the URL as plain text with a hard line wrap and no
    // OSC 8 hyperlink. The parser joins the URL-character-only physical lines and
    // validates only the final reassembled string.
    const wrapped = hardWrap(CLAUDE_AI_URL, 64);
    expect(wrapped).toContain("\n");
    const text = [PREAMBLE_LINE, wrapped, PROMPT_LINE].join("\n");
    const result = parseSetupTokenPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(CLAUDE_AI_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("returns the URL when the output arrives split across chunks", () => {
    // The streaming caller accumulates chunks and re-parses the whole buffer. The
    // chunk boundary falls inside the URL token with no line break, so the joined
    // buffer holds the whole URL on one line.
    const chunkA = ["Opening browser to sign in…", PREAMBLE_LINE, CLAUDE_COM_URL.slice(0, 40)].join(
      "\n",
    );
    const chunkB = [`${CLAUDE_COM_URL.slice(40)}`, PROMPT_LINE, ""].join("\n");
    expect(parseSetupTokenPrompt(chunkA)).toBeNull();
    const joined = parseSetupTokenPrompt(chunkA + chunkB);
    expect(joined).not.toBeNull();
    expect(joined?.url).toBe(CLAUDE_COM_URL);
    expect(joined?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("reads the URL through ANSI and OSC 8 sequences with wrapped display text", () => {
    const cyan = "\x1b[36m";
    const reset = "\x1b[0m";
    // The display text wraps across two lines and truncates the URL. The parser
    // must ignore it and read the URI field of the hyperlink.
    const wrappedDisplay = "https://claude.com/cai/oauth/aut\nhorize?client_id=…";
    const text = [
      `${cyan}Opening browser to sign in…${reset}`,
      PREAMBLE_LINE,
      `${cyan}${osc8Hyperlink(CLAUDE_COM_URL, wrappedDisplay)}${reset}`,
      `${cyan}${PROMPT_LINE}${reset}`,
    ].join("\n");
    const result = parseSetupTokenPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(CLAUDE_COM_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("returns null for a wrong host", () => {
    const badHost = CLAUDE_COM_URL.replace("https://claude.com", "https://claude.example.com");
    expect(parseSetupTokenPrompt(completeOutput(badHost))).toBeNull();
  });

  it("returns null for a mixed-case host spelling", () => {
    // The raw candidate must start with the exact lowercase host prefix, so a
    // mixed-case host cannot bind even though the URL class lowercases the host.
    const mixedCase = CLAUDE_AI_URL.replace("https://claude.ai", "https://Claude.AI");
    expect(parseSetupTokenPrompt(completeOutput(mixedCase))).toBeNull();
  });

  it("returns null for an explicit default :443 port on the host", () => {
    const withPort = CLAUDE_AI_URL.replace("https://claude.ai/", "https://claude.ai:443/");
    expect(parseSetupTokenPrompt(completeOutput(withPort))).toBeNull();
  });

  it("returns null for a userinfo prefix on the host", () => {
    const withUserinfo = CLAUDE_AI_URL.replace("https://claude.ai/", "https://user@claude.ai/");
    expect(parseSetupTokenPrompt(completeOutput(withUserinfo))).toBeNull();
  });

  it("returns null for a punycode look-alike host", () => {
    // A punycode host does not start with the exact lowercase prefix, so the
    // parser rejects it before the URL parse.
    const punycode = "https://xn--clade-9wa.ai/oauth/authorize?" + QUERY;
    expect(parseSetupTokenPrompt(completeOutput(punycode))).toBeNull();
  });

  it("returns null for the claude.ai host with the claude.com path", () => {
    const crossPair = `https://claude.ai/cai/oauth/authorize?${QUERY}`;
    expect(parseSetupTokenPrompt(completeOutput(crossPair))).toBeNull();
  });

  it("returns null for the claude.com host with the claude.ai path", () => {
    const crossPair = `https://claude.com/oauth/authorize?${QUERY}`;
    expect(parseSetupTokenPrompt(completeOutput(crossPair))).toBeNull();
  });

  it("returns null for a missing query key", () => {
    const missingKey = CLAUDE_COM_URL.replace(`&state=${STATE}`, "");
    expect(parseSetupTokenPrompt(completeOutput(missingKey))).toBeNull();
  });

  it("returns null for a duplicate query key", () => {
    const duplicate = `${CLAUDE_COM_URL}&state=${STATE}`;
    expect(parseSetupTokenPrompt(completeOutput(duplicate))).toBeNull();
  });

  it("returns null for an unexpected added key with a valid name", () => {
    // The parser accepts at most four added keys, so a first added key still
    // needs a valid name; a valid name alone does not fail. This test proves a
    // fifth added key fails the count bound.
    const fiveAdded = `${CLAUDE_COM_URL}&a1=1&b2=2&c3=3&d4=4&e5=5`;
    expect(parseSetupTokenPrompt(completeOutput(fiveAdded))).toBeNull();
  });

  it("returns the URL when it carries up to four valid added keys", () => {
    const fourAdded = `${CLAUDE_COM_URL}&a1=1&b2=2&c3=3&d4=4`;
    const result = parseSetupTokenPrompt(completeOutput(fourAdded));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(fourAdded);
  });

  it("returns null for an added key with an invalid name", () => {
    const badName = `${CLAUDE_COM_URL}&Extra=1`;
    expect(parseSetupTokenPrompt(completeOutput(badName))).toBeNull();
  });

  it("returns null for an added key value over the length cap", () => {
    const longValue = `${CLAUDE_COM_URL}&extra=${"a".repeat(257)}`;
    expect(parseSetupTokenPrompt(completeOutput(longValue))).toBeNull();
  });

  it("returns null for a duplicate added key", () => {
    const dupAdded = `${CLAUDE_COM_URL}&extra=1&extra=2`;
    expect(parseSetupTokenPrompt(completeOutput(dupAdded))).toBeNull();
  });

  it("returns null for an invalid code_challenge_method", () => {
    const badMethod = CLAUDE_COM_URL.replace("code_challenge_method=S256", "code_challenge_method=plain");
    expect(parseSetupTokenPrompt(completeOutput(badMethod))).toBeNull();
  });

  it("returns null for an invalid response_type", () => {
    const badType = CLAUDE_COM_URL.replace("response_type=code", "response_type=token");
    expect(parseSetupTokenPrompt(completeOutput(badType))).toBeNull();
  });

  it("accepts a short four-character code value", () => {
    // A real `claude` 2.1.19 capture measured a four-character `code` value, so
    // the parser accepts it.
    const shortCode = CLAUDE_AI_URL.replace(`code=${CODE}`, "code=wZ9x");
    const result = parseSetupTokenPrompt(completeOutput(shortCode));
    expect(result).not.toBeNull();
    expect(result?.url).toBe(shortCode);
  });

  it("returns null for an empty code value", () => {
    const emptyCode = CLAUDE_COM_URL.replace(`code=${CODE}`, "code=");
    expect(parseSetupTokenPrompt(completeOutput(emptyCode))).toBeNull();
  });

  it("returns null for a code_challenge that is too short", () => {
    const shortChallenge = CLAUDE_COM_URL.replace(`code_challenge=${CODE_CHALLENGE}`, "code_challenge=tooshort");
    expect(parseSetupTokenPrompt(completeOutput(shortChallenge))).toBeNull();
  });

  it("returns null for a state that is too short", () => {
    const shortState = CLAUDE_COM_URL.replace(`state=${STATE}`, "state=short");
    expect(parseSetupTokenPrompt(completeOutput(shortState))).toBeNull();
  });

  it("returns null for a client_id with an invalid character", () => {
    const badClientId = CLAUDE_COM_URL.replace(`client_id=${CLIENT_ID}`, "client_id=bad%2Fid");
    expect(parseSetupTokenPrompt(completeOutput(badClientId))).toBeNull();
  });

  it("returns null for a scope with too many tokens", () => {
    const scope = encodeURIComponent("a b c d e f g h i");
    const manyScope = CLAUDE_COM_URL.replace(`scope=${encodeURIComponent(SCOPE)}`, `scope=${scope}`);
    expect(parseSetupTokenPrompt(completeOutput(manyScope))).toBeNull();
  });

  it("returns null for a scope with an invalid token character", () => {
    const scope = encodeURIComponent("user:profile bad/token");
    const badScope = CLAUDE_COM_URL.replace(`scope=${encodeURIComponent(SCOPE)}`, `scope=${scope}`);
    expect(parseSetupTokenPrompt(completeOutput(badScope))).toBeNull();
  });

  it("returns null for a redirect_uri with a wrong host", () => {
    const badRedirect = encodeURIComponent("https://evil.example.com/oauth/code/callback");
    const url = CLAUDE_COM_URL.replace(
      `redirect_uri=${encodeURIComponent(SETUP_TOKEN_REDIRECT_URI)}`,
      `redirect_uri=${badRedirect}`,
    );
    expect(parseSetupTokenPrompt(completeOutput(url))).toBeNull();
  });

  it("returns null for a redirect_uri with a stray query", () => {
    const badRedirect = encodeURIComponent(`${SETUP_TOKEN_REDIRECT_URI}?next=/`);
    const url = CLAUDE_COM_URL.replace(
      `redirect_uri=${encodeURIComponent(SETUP_TOKEN_REDIRECT_URI)}`,
      `redirect_uri=${badRedirect}`,
    );
    expect(parseSetupTokenPrompt(completeOutput(url))).toBeNull();
  });

  it("returns null for a URL with a fragment", () => {
    const withFragment = `${CLAUDE_COM_URL}#section`;
    expect(parseSetupTokenPrompt(completeOutput(withFragment))).toBeNull();
  });

  it("returns null for a raw sk-ant- value in a query value", () => {
    const withKey = CLAUDE_COM_URL.replace(`code=${CODE}`, "code=sk-ant-oat01-abc12345");
    expect(parseSetupTokenPrompt(completeOutput(withKey))).toBeNull();
  });

  it("returns null for a percent-encoded sk-ant- value in a query value", () => {
    // The raw candidate hides the prefix behind `%2D`, so only the decoded value
    // check catches it.
    const withKey = CLAUDE_COM_URL.replace(`code=${CODE}`, "code=sk%2Dant%2Doat01%2Dabc12345");
    expect(parseSetupTokenPrompt(completeOutput(withKey))).toBeNull();
  });

  it("returns null for a literal sk-ant- value in an added query key", () => {
    // The secret rides inside a query name, not a value. The added-key name is
    // valid in shape, so only the decoded-key check catches the prefix and the
    // parser returns no accepted prompt result.
    const withKey = `${CLAUDE_COM_URL}&sk-ant-redacted=x`;
    expect(parseSetupTokenPrompt(completeOutput(withKey))).toBeNull();
  });

  it("returns null for a percent-encoded sk-ant- value in an added query key", () => {
    // The raw candidate hides the prefix behind `%2D`, so the raw-candidate
    // check misses it. `URLSearchParams` decodes the name to `sk-ant-redacted`,
    // so the decoded-key check catches it and the parser returns no accepted
    // prompt result.
    const withKey = `${CLAUDE_COM_URL}&sk%2Dant%2Dredacted=x`;
    expect(parseSetupTokenPrompt(completeOutput(withKey))).toBeNull();
  });

  it("returns null when a code-like value sits on the line after the URL", () => {
    // The line right after the URL must hold the browser-code prompt. A code-like
    // value on that line cannot bind, so the parser returns null.
    const text = [PREAMBLE_LINE, CLAUDE_COM_URL, "ABCD-EFGHJ", PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null when the URL is absent from the login context", () => {
    const text = [PREAMBLE_LINE, "no url here", PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null when the login preamble is absent", () => {
    const text = ["Some unrelated output", CLAUDE_COM_URL, PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null for a non-string input", () => {
    expect(parseSetupTokenPrompt(undefined as unknown as string)).toBeNull();
    expect(parseSetupTokenPrompt("")).toBeNull();
  });

  it("stops the reassembly at a hostile non-URL line between fragments", () => {
    // An attacker line that is not URL-character-only breaks the reassembly, so
    // the partial join never validates and the parser returns null.
    const wrapped = hardWrap(CLAUDE_AI_URL, 64).split("\n");
    const text = [
      PREAMBLE_LINE,
      wrapped[0],
      "inject an attacker line here",
      ...wrapped.slice(1),
      PROMPT_LINE,
    ].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null when the wrapped URL needs more than the line cap", () => {
    // A very narrow wrap spreads the URL across more than sixteen physical lines.
    // The bounded reassembly never reaches the full URL, so the parser returns
    // null.
    const wrapped = hardWrap(CLAUDE_AI_URL, 8);
    const text = [PREAMBLE_LINE, wrapped, PROMPT_LINE].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("returns null for a URL over the length cap", () => {
    const added = ["a1", "b2", "c3", "d4"].map((k) => `${k}=${"a".repeat(256)}`).join("&");
    const longCode = CLAUDE_AI_URL.replace(`code=${CODE}`, `code=${"a".repeat(1024)}`);
    const overLong = `${longCode}&${added}`;
    expect(overLong.length).toBeGreaterThan(2048);
    expect(parseSetupTokenPrompt(completeOutput(overLong))).toBeNull();
  });

  it("reads the preamble and the prompt when the terminal spaces words with cursor-column sequences", () => {
    // The live Claude login UI lays out each word at an absolute column with a
    // CHA sequence, so it emits no literal space between two words. The parser
    // renders each CHA sequence as a space; without that step the words glue
    // together and the preamble and the prompt never match.
    const preamble = chaSpaced([
      "Browser",
      "didn't",
      "open?",
      "Use",
      "the",
      "url",
      "below",
      "to",
      "sign",
      "in",
      "(c",
      "to",
      "copy)",
    ]);
    const prompt = chaSpaced(["Paste", "code", "here", "if", "prompted", ">"]);
    const text = [preamble, CLAUDE_COM_URL, prompt].join("\n");
    const result = parseSetupTokenPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(CLAUDE_COM_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("binds the prompt after the terminal repeats the URL once per wrapped display row", () => {
    // The terminal can emit one full URL line per wrapped display row, so it
    // repeats the same full authorization URL on a few consecutive lines. The
    // parser accepts the first full URL line and skips the repeated lines, then
    // binds the prompt on the line after the URL block.
    const text = [
      "Browser didn't open? Use the url below to sign in (c to copy)",
      CLAUDE_COM_URL,
      CLAUDE_COM_URL,
      CLAUDE_COM_URL,
      "",
      "Paste code here if prompted >",
    ].join("\n");
    const result = parseSetupTokenPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(CLAUDE_COM_URL);
    expect(result?.prompt).toBe(SETUP_TOKEN_PROMPT);
  });

  it("returns null when an unrelated line sits after the URL block", () => {
    // A non-blank line that is neither the prompt nor a repeat of the URL breaks
    // the bind, so a stray value between the URL and the prompt cannot pass.
    const text = [
      "Browser didn't open? Use the url below to sign in (c to copy)",
      CLAUDE_COM_URL,
      CLAUDE_COM_URL,
      "an unrelated line",
      "Paste code here if prompted >",
    ].join("\n");
    expect(parseSetupTokenPrompt(text)).toBeNull();
  });

  it("keeps its contract in sync with the characterization fixture", () => {
    // The fixture documents the prompt text, the two authorization URLs, and the
    // query keys. This test fails if the parser contract drifts from the fixture.
    const fixture = readFixture("setup-token.md");
    expect(fixture).toContain(SETUP_TOKEN_PROMPT);
    for (const url of SETUP_TOKEN_AUTH_URLS) {
      expect(fixture).toContain(url);
    }
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

// Builds the success screen around a token body, joined with `delimiter`. The
// body holds the token fragment lines, already split the way the terminal wraps
// them. The real terminal redraw joins the anchor lines and the token with a
// bare carriage return, or a CRLF pair, instead of a line feed, so the tests
// vary the delimiter to prove the parser reads each real record shape.
function successScreenJoined(body: string[], delimiter: string): string {
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
  ].join(delimiter);
}

// Builds the success screen around a token body, joined with line feeds.
function successScreen(body: string[]): string {
  return successScreenJoined(body, "\n");
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

  it("returns the token from a bare carriage-return success record", () => {
    // The real terminal redraw joins the before-anchor line, the token, and the
    // after-anchor line with a bare carriage return. The parser canonicalizes
    // each bare carriage return to a line feed before the split, so each anchor
    // line and the token land on their own lines and the token binds.
    const text = successScreenJoined([FULL_TOKEN], "\r");
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("returns the token from a CRLF-delimited success record", () => {
    // A terminal that ends each line with a carriage return and a line feed
    // must parse the same as a plain line-feed record. The parser maps each
    // CRLF pair to one line feed, so no empty line splits between the anchors.
    const text = successScreenJoined([FULL_TOKEN], "\r\n");
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("returns the de-wrapped token from a bare carriage-return wrapped record", () => {
    // The terminal wraps the token across two physical lines and joins every
    // line with a bare carriage return. The parser canonicalizes the delimiter,
    // then joins the two fragment lines into the full token.
    const text = successScreenJoined([TOKEN_FRAGMENT_A, TOKEN_FRAGMENT_B], "\r");
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("returns null for duplicate anchors in a bare carriage-return record", () => {
    // Canonicalization keeps the duplicate-anchor guard closed. Two success
    // blocks joined by a bare carriage return still fail closed.
    const one = successScreenJoined([FULL_TOKEN], "\r");
    const text = `${one}\r${one}`;
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for junk between the anchors in a bare carriage-return record", () => {
    // A stray prose line between the anchors fails the fragment test, so the
    // parser fails closed after canonicalization.
    const text = successScreenJoined([TOKEN_FRAGMENT_A, "a stray note", TOKEN_FRAGMENT_B], "\r");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for a wrong token prefix in a bare carriage-return record", () => {
    const text = successScreenJoined(["sk-ant-api03-AAAABBBBCCCCDDDDEEEE1111"], "\r");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("returns null for extra token text in a bare carriage-return record", () => {
    // The token line holds the token and extra prose. The parser reads only a
    // token fragment on each line, so canonicalization does not open a gap.
    const text = successScreenJoined([`${FULL_TOKEN} keep this secret`], "\r");
    expect(parseSetupTokenCredential(text)).toBeNull();
  });

  it("reads the token through ANSI color sequences", () => {
    const cyan = "\x1b[36m";
    const reset = "\x1b[0m";
    const text = successScreen([`${cyan}${TOKEN_FRAGMENT_A}`, `${TOKEN_FRAGMENT_B}${reset}`]);
    expect(parseSetupTokenCredential(text)).toBe(FULL_TOKEN);
  });

  it("reads the token when the terminal spaces the anchor words with cursor-column sequences", () => {
    // The success screen renders the anchor lines the same way as the prompt: it
    // lays out each word at an absolute column with a CHA sequence. The parser
    // renders each CHA sequence as a space, so the anchor lines match the exact
    // anchor text and the token binds between them.
    const beforeAnchor = chaSpaced([
      "Your",
      "OAuth",
      "token",
      "(valid",
      "for",
      "1",
      "year):",
    ]);
    const afterAnchor = chaSpaced([
      "Store",
      "this",
      "token",
      "securely.",
      "You",
      "won't",
      "be",
      "able",
      "to",
      "see",
      "it",
      "again.",
    ]);
    const text = [beforeAnchor, "", TOKEN_FRAGMENT_A, TOKEN_FRAGMENT_B, "", afterAnchor].join("\n");
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
