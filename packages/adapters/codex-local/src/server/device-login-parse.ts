// The device-login output parser. It reads the Codex `login --device-auth`
// output and returns the login URL and the one-time code, or null.
//
// Security (Control 1 — strict validation): the parser accepts only the exact
// origin and path of the device-login URL. It rejects any query, any fragment, a
// different origin, and a different path. It accepts only the short-code
// structure `XXXX-XXXXX` (four characters, a hyphen, then five characters). The
// parser never logs the URL, the code, or any input byte, and it keeps them out
// of every thrown error. The parser is a pure function.

export interface DeviceLoginPrompt {
  url: string;
  code: string;
}

// The one and only accepted device-login URL. The parser returns this exact
// constant string on a match, so the output is never a caller-controlled value.
export const DEVICE_LOGIN_URL = "https://auth.openai.com/codex/device";

// Codex CLI 0.128.0 and later wrap the login URL and the one-time code in ANSI
// color sequences. A color sequence is a Control Sequence Introducer (CSI): the
// ESC control byte, a `[`, zero or more parameter bytes (0x30-0x3F), zero or
// more intermediate bytes (0x20-0x2F), and one final byte (0x40-0x7E). The
// parser removes every CSI sequence first, so a colored URL or code reads the
// same as a plain one. The strip only normalizes the input; the URL and the
// code still pass the strict validation below.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// A candidate URL token is a run of non-space characters that starts with an
// http or https scheme. The parser validates each candidate with the `URL`
// class; the regular expression only splits tokens out of the text.
const URL_TOKEN_RE = /https?:\/\/\S+/g;

// Trailing punctuation that prose commonly puts right after a URL. The parser
// strips only these characters. It never strips `?` or `#`, so a URL with a
// query or a fragment stays malformed and the parser rejects it.
const TRAILING_PUNCTUATION_RE = /[)\].,;:!]+$/;

// The one-time code structure on a dedicated line: four characters, a hyphen,
// then five characters, and nothing else on the line. The Codex prompt prints
// the code alone on the line that comes right after the preamble line. So the
// pattern matches the whole line. A code-shaped token that shares a line with
// other text cannot match. The real code alphabet is a Codex detail that the
// grounded capture did not keep (the capture redacted the code to `?`). So the
// parser binds the token class to alphanumerics and the redaction sentinel `?`.
const CODE_LINE_RE = /^([A-Za-z0-9?]{4}-[A-Za-z0-9?]{5})$/;

// The prompt line that introduces the one-time code. The Codex prompt prints
// the phrase "one-time code" on the line right before the code. The parser
// anchors the code search on this phrase. So the code binds to the prompt line
// that introduces it. A code-shaped token that sits between the URL and this
// phrase cannot bind, because the parser reads the code only after the phrase.
const CODE_PREAMBLE_RE = /one-time code/i;

// The maximum number of characters between the end of the URL and the start of
// the code preamble. The Codex prompt prints the preamble about one line after
// the URL. The parser looks for the preamble only inside this window after the
// URL. So a preamble far away in the output cannot bind to the URL.
const MAX_URL_TO_PREAMBLE_GAP = 256;

// The maximum number of characters after the end of the preamble line that the
// parser reads for the code. The Codex prompt prints the code on the line right
// after the preamble line. The parser looks for the code only inside this window
// after the preamble line. The window is large enough for the real code line and
// small enough to reject distant noise.
const MAX_PREAMBLE_TO_CODE_GAP = 128;

// The result of a URL search: the canonical URL and the index of the first
// character after the matched URL token. The code search starts at this index.
interface DeviceUrlMatch {
  url: string;
  end: number;
}

/**
 * Returns the exact device-login URL and its end index when `text` holds it as
 * a standalone token with the exact origin `https://auth.openai.com` and the
 * exact path `/codex/device` and no query, fragment, or credentials. Returns
 * null otherwise. Returns the canonical {@link DEVICE_LOGIN_URL} constant on a
 * match. The `end` index is the position of the first character after the
 * matched token in `text`.
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
      parsed.protocol === "https:" &&
      parsed.host === "auth.openai.com" &&
      parsed.pathname === "/codex/device" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    ) {
      return { url: DEVICE_LOGIN_URL, end: (match.index ?? 0) + token.length };
    }
  }
  return null;
}

/**
 * Returns the one-time code when `text` holds the code preamble after
 * `fromIndex` and a dedicated code line after that preamble line. The parser
 * first finds the "one-time code" preamble in a window after the URL. It then
 * advances past the end of the preamble line and reads the first non-blank line
 * after it. That line must hold only the `XXXX-XXXXX` code. So the code binds to
 * the dedicated code line that the prompt prints right after the preamble line.
 * A code-shaped token between the URL and the preamble cannot bind. A code-shaped
 * token that shares the preamble line cannot bind. A code-shaped token inside a
 * line that also holds other text cannot bind. Returns null when the preamble is
 * absent, when the preamble has no line break after it, or when the first
 * non-blank line after the preamble line is not a code line.
 */
function findShortCode(text: string, fromIndex: number): string | null {
  const preambleWindow = text.slice(fromIndex, fromIndex + MAX_URL_TO_PREAMBLE_GAP);
  const preambleMatch = CODE_PREAMBLE_RE.exec(preambleWindow);
  if (!preambleMatch) return null;
  // Advance to the end of the preamble line. The code sits on the next line, so
  // the parser reads the code only after the preamble line ends. A code-shaped
  // token on the preamble line cannot bind.
  const preambleEnd = fromIndex + preambleMatch.index + preambleMatch[0].length;
  const lineBreak = text.indexOf("\n", preambleEnd);
  if (lineBreak === -1) return null;
  const codeWindow = text.slice(lineBreak + 1, lineBreak + 1 + MAX_PREAMBLE_TO_CODE_GAP);
  // Read the first non-blank line after the preamble line. It must hold only the
  // code. So the parser binds the code to the dedicated code line, and it rejects
  // a line that mixes the code with other text.
  for (const line of codeWindow.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = CODE_LINE_RE.exec(trimmed);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Parses Codex device-login output. Removes ANSI color sequences first, so
 * colored output from Codex CLI 0.128.0 and later reads the same as plain
 * output. The parser reads the URL first, then finds the "one-time code"
 * preamble after the URL, then reads the code from the dedicated code line right
 * after the preamble line. So the code binds to the prompt line that introduces
 * it, and a code-shaped token between the URL and the preamble, on the preamble
 * line, or mixed with other text on a later line, cannot form a prompt. Returns
 * the login URL and the one-time code when both are present and valid. Returns
 * null for any other input, including a non-string input, an absent prompt, a URL
 * with a query or a fragment, a wrong origin or path, and a malformed short code.
 * Never throws on input, and never puts the URL or the code into a log or an error.
 */
export function parseDeviceLoginPrompt(text: string): DeviceLoginPrompt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = text.replace(ANSI_CSI_RE, "");
  const urlMatch = findExactDeviceUrl(clean);
  if (!urlMatch) return null;
  const code = findShortCode(clean, urlMatch.end);
  if (!code) return null;
  return { url: urlMatch.url, code };
}
