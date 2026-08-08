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

// A candidate URL token is a run of non-space characters that starts with an
// http or https scheme. The parser validates each candidate with the `URL`
// class; the regular expression only splits tokens out of the text.
const URL_TOKEN_RE = /https?:\/\/\S+/g;

// Trailing punctuation that prose commonly puts right after a URL. The parser
// strips only these characters. It never strips `?` or `#`, so a URL with a
// query or a fragment stays malformed and the parser rejects it.
const TRAILING_PUNCTUATION_RE = /[)\].,;:!]+$/;

// The one-time code structure: four characters, a hyphen, then five characters.
// The real code alphabet is a Codex detail that the grounded capture did not
// keep (the capture redacted the code to `?`). So the parser matches the
// grounded structure and binds the token class to alphanumerics and the
// redaction sentinel `?`. The code sits on its own token, so the pattern anchors
// on a word boundary at the start and requires a space or the end after it.
const SHORT_CODE_RE = /(?:^|\s)([A-Za-z0-9?]{4}-[A-Za-z0-9?]{5})(?=\s|$)/m;

/**
 * Returns the exact device-login URL when `text` holds it as a standalone token
 * with the exact origin `https://auth.openai.com` and the exact path
 * `/codex/device` and no query, fragment, or credentials. Returns null
 * otherwise. Returns the canonical {@link DEVICE_LOGIN_URL} constant on a match.
 */
function findExactDeviceUrl(text: string): string | null {
  const tokens = text.match(URL_TOKEN_RE);
  if (!tokens) return null;
  for (const token of tokens) {
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
      return DEVICE_LOGIN_URL;
    }
  }
  return null;
}

/**
 * Returns the one-time code when `text` holds a token with the structure
 * `XXXX-XXXXX`. Returns null otherwise.
 */
function findShortCode(text: string): string | null {
  const match = SHORT_CODE_RE.exec(text);
  return match ? match[1] : null;
}

/**
 * Parses Codex device-login output. Returns the login URL and the one-time code
 * when both are present and valid. Returns null for any other input, including a
 * non-string input, an absent prompt, a URL with a query or a fragment, a wrong
 * origin or path, and a malformed short code. Never throws on input, and never
 * puts the URL or the code into a log or an error.
 */
export function parseDeviceLoginPrompt(text: string): DeviceLoginPrompt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const url = findExactDeviceUrl(text);
  if (!url) return null;
  const code = findShortCode(text);
  if (!code) return null;
  return { url, code };
}
