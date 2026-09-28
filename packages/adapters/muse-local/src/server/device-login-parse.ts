// The device-login output parser. It reads the `muse login` output and returns
// the authorization URL and the one-time code, or null. It mirrors the Grok
// parser (packages/adapters/grok-local/src/server/device-login-parse.ts).
//
// Security (strict validation): the parser accepts only the exact origin
// `https://auth.meta.com` and the exact path `/oauth/device/`, rejects any
// fragment or credentials, and accepts exactly one query key, `code`. The code
// must match the strict short-code pattern and equal the code printed on its
// own line after the preamble. The parser never logs the URL, the code, or any
// input byte, and never throws on input. It is a pure function.

export interface DeviceLoginPrompt {
  url: string;
  code: string;
}

/** The one and only accepted device-login command. */
export const MUSE_DEVICE_LOGIN_COMMAND = "muse login";

/** The one and only accepted device-login URL origin. */
export const MUSE_DEVICE_LOGIN_URL_ORIGIN = "https://auth.meta.com";

/** The one and only accepted device-login URL path. */
export const MUSE_DEVICE_LOGIN_URL_PATH = "/oauth/device/";

// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const URL_TOKEN_RE = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION_RE = /[)\].,;:!]+$/;
// Every observed Muse code is four uppercase alphanumerics, a hyphen, four more.
const CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const CODE_PREAMBLE = "confirm this code matches:";
const MAX_URL_TO_PREAMBLE_GAP = 256;
const MAX_PREAMBLE_TO_CODE_GAP = 128;

interface DeviceUrlMatch {
  url: string;
  code: string;
  end: number;
}

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
      parsed.origin !== MUSE_DEVICE_LOGIN_URL_ORIGIN ||
      parsed.pathname !== MUSE_DEVICE_LOGIN_URL_PATH ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      continue;
    }
    const keys = Array.from(parsed.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== "code") continue;
    const code = parsed.searchParams.get("code");
    if (!code || !CODE_PATTERN.test(code)) continue;
    return { url: parsed.toString(), code, end: (match.index ?? 0) + token.length };
  }
  return null;
}

function findStandaloneCode(text: string, fromIndex: number): string | null {
  const preambleWindow = text.slice(fromIndex, fromIndex + MAX_URL_TO_PREAMBLE_GAP);
  const preambleIndex = preambleWindow.indexOf(CODE_PREAMBLE);
  if (preambleIndex === -1) return null;
  const preambleEnd = fromIndex + preambleIndex + CODE_PREAMBLE.length;
  const lineBreak = text.indexOf("\n", preambleEnd);
  if (lineBreak === -1) return null;
  const codeWindow = text.slice(lineBreak + 1, lineBreak + 1 + MAX_PREAMBLE_TO_CODE_GAP);
  const lines = codeWindow.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // The code line must be complete (followed by a line break), so a code
    // still arriving on the terminal is never matched by a prefix.
    if (index === lines.length - 1) return null;
    return CODE_PATTERN.test(trimmed) ? trimmed : null;
  }
  return null;
}

/**
 * Parses Muse device-login output. Removes ANSI color sequences and carriage
 * returns first (a pseudo-terminal prints CRLF). Returns the prompt only when
 * the dedicated code line equals the code the URL query carries.
 */
export function parseMuseDeviceLoginPrompt(text: string): DeviceLoginPrompt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = text.replace(ANSI_CSI_RE, "").replace(/\r\n?/g, "\n");
  const urlMatch = findExactDeviceUrl(clean);
  if (!urlMatch) return null;
  const lineCode = findStandaloneCode(clean, urlMatch.end);
  if (!lineCode || lineCode !== urlMatch.code) return null;
  return { url: urlMatch.url, code: lineCode };
}
