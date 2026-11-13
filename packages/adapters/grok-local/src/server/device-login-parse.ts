// The device-login output parser. It reads the Grok `login --device-auth`
// output and returns the authorization URL and the one-time code, or null.
//
// Security (Control 1 — strict validation): the parser accepts only the exact
// origin `https://accounts.x.ai` and the exact path `/oauth2/device`, and it
// rejects any fragment, a different origin, or a different path. Unlike the
// Codex device-login URL, the Grok URL carries a query: the parser accepts
// exactly one query key, `user_code`, and rejects a repeated key or an extra
// key. It requires the `user_code` value to match the strict short-code
// pattern and to equal the code that stands alone on its own line. The parser
// returns the printed URL after the platform `URL` parser validates and
// normalizes it, so the output is never a raw, unvalidated token. The parser
// never logs the URL, the code, or any input byte, and it keeps them out of
// every thrown error. The parser is a pure function.

export interface DeviceLoginPrompt {
  url: string;
  code: string;
}

/** The one and only accepted device-login command. */
export const GROK_DEVICE_LOGIN_COMMAND = "grok login --device-auth";

/** The one and only accepted device-login URL origin. */
export const GROK_DEVICE_LOGIN_URL_ORIGIN = "https://accounts.x.ai";

/** The one and only accepted device-login URL path. */
export const GROK_DEVICE_LOGIN_URL_PATH = "/oauth2/device";

// Grok CLI wraps the URL and the code in ANSI color sequences on a later
// release, the same way Codex CLI 0.128.0 and later do. A color sequence is a
// Control Sequence Introducer (CSI): the ESC control byte, a `[`, zero or more
// parameter bytes (0x30-0x3F), zero or more intermediate bytes (0x20-0x2F), and
// one final byte (0x40-0x7E). The parser removes every CSI sequence first, so a
// colored URL or code reads the same as a plain one. The strip only normalizes
// the input; the URL and the code still pass the strict validation below.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// A candidate URL token is a run of non-space characters that starts with an
// http or https scheme. The parser validates each candidate with the `URL`
// class; the regular expression only splits tokens out of the text.
const URL_TOKEN_RE = /https?:\/\/\S+/g;

// Trailing punctuation that prose commonly puts right after a URL. The parser
// strips only these characters. It never strips `?` or `#`, so a URL with a
// fragment stays malformed and the parser rejects it.
const TRAILING_PUNCTUATION_RE = /[)\].,;:!]+$/;

// The one-time code structure: four characters, a hyphen, then four
// characters, and nothing else. Every observed grok code matched this shape.
// The alphabet is not published, so the pattern binds the token class to
// alphanumerics rather than a fixed character set.
const CODE_PATTERN = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;

// The prompt line that introduces the one-time code, printed exactly this way.
const CODE_PREAMBLE = "Confirm this code in your browser:";

// The maximum number of characters between the end of the URL and the start of
// the code preamble. The captured prompt prints the preamble a few characters
// after the URL. The parser looks for the preamble only inside this window
// after the URL, so a preamble far away in the output cannot bind to the URL.
const MAX_URL_TO_PREAMBLE_GAP = 256;

// The maximum number of characters after the end of the preamble line that the
// parser reads for the code. The captured prompt prints the code on the line
// right after the preamble line.
const MAX_PREAMBLE_TO_CODE_GAP = 128;

// The result of a URL search: the validated URL, the code the query carries,
// and the index of the first character after the matched URL token. The code
// search starts at this index.
interface DeviceUrlMatch {
  url: string;
  code: string;
  end: number;
}

/**
 * Returns the validated device-login URL, the code its `user_code` query
 * carries, and the end index, when `text` holds a standalone token with the
 * exact origin {@link GROK_DEVICE_LOGIN_URL_ORIGIN} and the exact path
 * {@link GROK_DEVICE_LOGIN_URL_PATH}, no fragment, no credentials, exactly one
 * query key named `user_code`, and a `user_code` value that matches the strict
 * short-code pattern. Returns null otherwise. Returns the platform `URL`
 * parser's normalized form of the matched token, so the accepting rules bound
 * the output even though it is not a fixed constant. The `end` index is the
 * position of the first character after the matched token in `text`.
 */
function findExactDeviceUrl(text: string): DeviceUrlMatch | null {
  for (const match of text.matchAll(URL_TOKEN_RE)) {
    const token = match[0];
    const cleaned = token.replace(TRAILING_PUNCTUATION_RE, "");
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.host !== "accounts.x.ai" ||
      parsed.pathname !== GROK_DEVICE_LOGIN_URL_PATH ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      continue;
    }
    // Accept exactly one query key, `user_code`. Comparing the whole key list
    // rejects a repeated key and an extra key alike.
    const keys = Array.from(parsed.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== "user_code") continue;
    const code = parsed.searchParams.get("user_code");
    if (!code || !CODE_PATTERN.test(code)) continue;
    return { url: parsed.toString(), code, end: (match.index ?? 0) + token.length };
  }
  return null;
}

/**
 * Returns the one-time code when `text` holds the code preamble after
 * `fromIndex` and a dedicated code line after that preamble line. Mirrors the
 * Codex parser's proximity-bound search: the preamble must appear in a window
 * after the URL, and the code must be the first non-blank line after the
 * preamble line, trimmed, and hold nothing else. Returns null when the
 * preamble is absent, when the preamble has no line break after it, or when
 * the first non-blank line after the preamble line is not a code line.
 */
function findStandaloneCode(text: string, fromIndex: number): string | null {
  const preambleWindow = text.slice(fromIndex, fromIndex + MAX_URL_TO_PREAMBLE_GAP);
  const preambleIndex = preambleWindow.indexOf(CODE_PREAMBLE);
  if (preambleIndex === -1) return null;
  const preambleEnd = fromIndex + preambleIndex + CODE_PREAMBLE.length;
  const lineBreak = text.indexOf("\n", preambleEnd);
  if (lineBreak === -1) return null;
  const codeWindow = text.slice(lineBreak + 1, lineBreak + 1 + MAX_PREAMBLE_TO_CODE_GAP);
  for (const line of codeWindow.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return CODE_PATTERN.test(trimmed) ? trimmed : null;
  }
  return null;
}

/**
 * Parses Grok device-login output. Removes ANSI color sequences first. The
 * parser reads the URL first, validates its query and its embedded code, then
 * finds the code preamble after the URL and reads the code from the dedicated
 * code line right after the preamble line. It returns the prompt only when the
 * code on that dedicated line equals the code the URL query carries. Returns
 * null for any other input, including a non-string input, an absent prompt, a
 * wrong origin or path, a URL with a fragment, a malformed or mismatched query,
 * and a malformed short code. Never throws on input, and never puts the URL or
 * the code into a log or an error.
 */
export function parseGrokDeviceLoginPrompt(text: string): DeviceLoginPrompt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = text.replace(ANSI_CSI_RE, "");
  const urlMatch = findExactDeviceUrl(clean);
  if (!urlMatch) return null;
  const lineCode = findStandaloneCode(clean, urlMatch.end);
  if (!lineCode) return null;
  if (lineCode !== urlMatch.code) return null;
  return { url: urlMatch.url, code: lineCode };
}
