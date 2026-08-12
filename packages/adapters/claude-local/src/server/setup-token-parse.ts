// The Claude `setup-token` parsers. They read the interactive login output of
// Claude Code. `parseSetupTokenPrompt` returns the authorization URL and the
// browser-code prompt, or null. `parseSetupTokenCredential` returns the minted
// OAuth token from the success screen, or null.
//
// Security (strict validation): the prompt parser accepts only the exact origin
// and path of the authorization URL, and only the exact set of query keys. It
// rejects any other origin, path, query, or fragment. It binds the browser-code
// prompt to a dedicated line right after the URL line, so an unrelated code-like
// value on the wrong line cannot form a prompt. It rejects an API-key-shaped
// value inside the URL.
//
// The token parser binds the token to the exact success record: it requires the
// before-anchor line and the after-anchor line, in that order, exactly one time
// each, and it reads only the lines between them. It de-wraps the token across
// the physical terminal lines. It fails closed for any other input. Both parsers
// never log any input byte, and they keep every input byte out of each thrown
// error. Both parsers are pure functions.

export interface SetupTokenPrompt {
  // The validated authorization URL, exactly as the terminal emitted it.
  url: string;
  // The canonical browser-code prompt. The parser returns the constant
  // {@link SETUP_TOKEN_PROMPT}, so the output is never a caller-controlled value.
  prompt: string;
}

// The canonical browser-code prompt text. The Claude login UI prints this line
// to ask the user to paste the code from the browser. The parser returns this
// exact constant on a match.
export const SETUP_TOKEN_PROMPT = "Paste code here if prompted";

// The one and only accepted authorization URL origin.
export const SETUP_TOKEN_URL_ORIGIN = "https://claude.com";

// The one and only accepted authorization URL path.
export const SETUP_TOKEN_URL_PATH = "/cai/oauth/authorize";

// The exact set of query keys of the authorization URL. The parser accepts the
// URL only when its query keys equal this set: no missing key, no extra key, and
// no duplicate key. The parser does not validate the query values, because the
// values are the real OAuth PKCE parameters that the user must visit.
export const SETUP_TOKEN_URL_QUERY_KEYS = [
  "client_id",
  "code",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
] as const;

// An ANSI Control Sequence Introducer (CSI): the ESC control byte, a `[`, zero
// or more parameter bytes (0x30-0x3F), zero or more intermediate bytes
// (0x20-0x2F), and one final byte (0x40-0x7E). The Claude terminal wraps the
// output in CSI color sequences. The parser removes every CSI sequence first, so
// a colored prompt reads the same as a plain one.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// An OSC 8 hyperlink. The terminal emits the URL through an OSC 8 hyperlink plus
// wrapped display text. The hyperlink carries the true, unwrapped URL in its URI
// field, while the display text may wrap across lines. The parser replaces the
// whole hyperlink (open sequence, display text, close sequence) with the URI, so
// it reads the unwrapped URL and drops the wrapped display text. The URI field
// is the first capture group. The terminator of each OSC sequence is the String
// Terminator (ESC `\`) or the BEL byte.
// eslint-disable-next-line no-control-regex
const OSC8_HYPERLINK_RE =
  /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;[^;\x1b\x07]*;(?:\x1b\\|\x07)/g;

// Any remaining OSC sequence. A partial output chunk can hold an OSC 8 open
// sequence without its close sequence. The parser removes each leftover OSC
// sequence after it replaces the complete hyperlinks.
// eslint-disable-next-line no-control-regex
const OSC_ANY_RE = /\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g;

// A candidate URL token: a run of non-space characters that starts with an http
// or https scheme. The parser validates each candidate with the `URL` class; the
// regular expression only splits tokens out of the text.
const URL_TOKEN_RE = /https?:\/\/\S+/g;

// Trailing punctuation that prose commonly puts right after a URL. The parser
// strips only these characters. It never strips `?` or `#`, so a URL with a
// stray query or a fragment stays malformed and the parser rejects it.
const TRAILING_PUNCTUATION_RE = /[)\].,;:!]+$/;

// The line that introduces the URL. The Claude login UI prints this phrase right
// before the URL. The parser anchors the URL search on this phrase, so a URL far
// from the login context cannot bind.
const URL_PREAMBLE_RE = /the url below to sign in/i;

// The browser-code prompt on a dedicated line. The line starts with the exact
// prompt phrase. The line can end with the input caret `>` and masked echo `*`
// characters and spaces. The pattern rejects the phrase when other prose shares
// the line.
const PROMPT_LINE_RE = /^Paste code here if prompted\b[\s>*]*$/;

// An API-key-shaped value. The Claude setup token and API key start with the
// `sk-ant-` prefix. The parser rejects a URL that embeds such a value, so a
// secret cannot ride inside the authorization URL.
const API_KEY_RE = /sk-ant-[a-z0-9-]{2,}/i;

// The maximum number of characters between the end of the URL preamble line and
// the start of the URL. The Claude UI prints the URL right after the preamble.
// The parser looks for the URL only inside this window, so a URL far from the
// preamble cannot bind.
const MAX_PREAMBLE_TO_URL_GAP = 512;

// The maximum number of characters after the end of the URL line that the parser
// reads for the browser-code prompt. The Claude UI prints the prompt one line
// after the URL. The window is large enough for the real prompt line and small
// enough to reject distant noise.
const MAX_URL_TO_PROMPT_GAP = 256;

// The result of a URL search: the validated URL and the index of the first
// character after the matched URL token in the search window.
interface SetupTokenUrlMatch {
  url: string;
  end: number;
}

/**
 * Removes the terminal control sequences from `text`. Replaces each OSC 8
 * hyperlink with its true URI, so the parser reads the unwrapped URL and drops
 * the wrapped display text. Removes each leftover OSC sequence and each ANSI CSI
 * sequence. Returns plain text. The function only normalizes the input; the URL
 * and the prompt still pass the strict validation below.
 */
function stripTerminalControls(text: string): string {
  return text
    .replace(OSC8_HYPERLINK_RE, "$1")
    .replace(OSC_ANY_RE, "")
    .replace(ANSI_CSI_RE, "");
}

/**
 * Returns the slice of `text` that starts at `start` and holds at most
 * `maxLength` characters. The parser uses this window to bound a gap between two
 * anchors, so a distant match cannot bind.
 */
function gapWindow(text: string, start: number, maxLength: number): string {
  return text.slice(start, start + maxLength);
}

/**
 * Returns true when the query keys of `parsed` equal
 * {@link SETUP_TOKEN_URL_QUERY_KEYS} exactly: no missing key, no extra key, and
 * no duplicate key.
 */
function hasExactQueryKeys(parsed: URL): boolean {
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== SETUP_TOKEN_URL_QUERY_KEYS.length) return false;
  const seen = new Set(keys);
  if (seen.size !== keys.length) return false;
  return SETUP_TOKEN_URL_QUERY_KEYS.every((key) => seen.has(key));
}

/**
 * Returns the authorization URL and its end index when `window` holds it with
 * the exact origin {@link SETUP_TOKEN_URL_ORIGIN}, the exact path
 * {@link SETUP_TOKEN_URL_PATH}, the exact query keys, no fragment, and no
 * credentials. Rejects a URL that embeds an API-key-shaped value. Returns null
 * otherwise. The `end` index is the position of the first character after the
 * matched token in `window`.
 */
function findExactUrl(window: string): SetupTokenUrlMatch | null {
  for (const match of window.matchAll(URL_TOKEN_RE)) {
    const token = match[0];
    if (API_KEY_RE.test(token)) continue;
    const cleaned = token.replace(TRAILING_PUNCTUATION_RE, "");
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    if (
      parsed.protocol === "https:" &&
      parsed.host === "claude.com" &&
      parsed.pathname === SETUP_TOKEN_URL_PATH &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      hasExactQueryKeys(parsed)
    ) {
      return { url: cleaned, end: (match.index ?? 0) + token.length };
    }
  }
  return null;
}

/**
 * Returns the canonical browser-code prompt when `text` holds it on a dedicated
 * line after the URL line. The parser advances past the URL line to the first
 * newline, then reads the first non-blank line inside a window after it. That
 * line must match the exact prompt shape. So the prompt binds to the dedicated
 * line that the UI prints right after the URL. A code-like value on that line, or
 * the prompt phrase mixed with other prose, cannot bind. Returns null when the
 * URL line has no line break after it, or when the first non-blank line is not
 * the prompt.
 */
function findBrowserCodePrompt(text: string, urlEnd: number): string | null {
  const lineBreak = text.indexOf("\n", urlEnd);
  if (lineBreak === -1) return null;
  const window = gapWindow(text, lineBreak + 1, MAX_URL_TO_PROMPT_GAP);
  for (const line of window.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return PROMPT_LINE_RE.test(trimmed) ? SETUP_TOKEN_PROMPT : null;
  }
  return null;
}

/**
 * Parses Claude `setup-token` login output. Removes ANSI CSI sequences and OSC 8
 * hyperlink sequences first, so colored and hyperlinked output reads the same as
 * plain output. The parser finds the URL preamble, then the exact authorization
 * URL inside a window after the preamble, then the browser-code prompt on the
 * dedicated line after the URL line. So the URL binds to the login context and
 * the prompt binds to the URL. Returns the authorization URL and the browser-code
 * prompt when both are present and valid. Returns null for any other input,
 * including a non-string input, an absent preamble, a URL with a wrong origin,
 * path, query, or fragment, an API-key-shaped URL, and a missing or misplaced
 * prompt. Never throws on input, and never puts any input byte into a log or an
 * error. This phase returns no token.
 */
export function parseSetupTokenPrompt(text: string): SetupTokenPrompt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = stripTerminalControls(text);
  const preamble = URL_PREAMBLE_RE.exec(clean);
  if (!preamble) return null;
  const afterPreamble = preamble.index + preamble[0].length;
  const urlWindow = gapWindow(clean, afterPreamble, MAX_PREAMBLE_TO_URL_GAP);
  const urlMatch = findExactUrl(urlWindow);
  if (!urlMatch) return null;
  const urlEnd = afterPreamble + urlMatch.end;
  const prompt = findBrowserCodePrompt(clean, urlEnd);
  if (!prompt) return null;
  return { url: urlMatch.url, prompt };
}

// --- The success token parser ------------------------------------------------

// The literal prefix of the Claude setup-token OAuth token. The success screen
// prints a token that starts with this exact prefix. The opaque tail follows.
export const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";

// The line that introduces the token. The success screen prints this exact line
// right before the token block. The token parser binds the token to this anchor.
export const SETUP_TOKEN_BEFORE_ANCHOR = "Your OAuth token (valid for 1 year):";

// The line that follows the token. The success screen prints this exact line
// right after the token block. The token parser binds the token to this anchor.
export const SETUP_TOKEN_AFTER_ANCHOR =
  "Store this token securely. You won't be able to see it again.";

// One physical line of the token. The terminal wraps the token at the
// pseudo-terminal width, so one physical line holds one fragment of the token
// character class. The token character class is `[A-Za-z0-9_-]`; the opaque tail
// can contain `-`, so a line fragment can contain `-`.
const TOKEN_FRAGMENT_RE = /^[A-Za-z0-9_-]+$/;

// The full token shape after the parser joins the wrapped fragments. The token
// starts with the exact prefix and continues over the token character class. The
// minimum tail length rejects a bare prefix and a short, noisy candidate. A real
// opaque tail is far longer than this floor.
const FULL_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

/**
 * Returns the index of the one line that equals `anchor` after a trim. Returns
 * null when no line matches. Returns null when more than one line matches, so a
 * duplicate success block fails closed.
 */
function singleAnchorIndex(lines: string[], anchor: string): number | null {
  let found: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== anchor) continue;
    if (found !== null) return null;
    found = i;
  }
  return found;
}

/**
 * Parses the Claude `setup-token` success screen and returns the minted OAuth
 * token, or null. The parser removes the terminal control sequences first, then
 * binds the token to the exact success record. It requires the before-anchor
 * line {@link SETUP_TOKEN_BEFORE_ANCHOR} and the after-anchor line
 * {@link SETUP_TOKEN_AFTER_ANCHOR}, in that order, exactly one time each. It
 * reads only the lines between the two anchors. It de-wraps the token: it joins
 * the fragment lines with no separator, the same way the terminal split one
 * token across the physical lines. It validates the joined value against the
 * token shape.
 *
 * The parser fails closed for any other input. It returns null for a
 * token-shaped value outside the two anchors (before submit, in retry or error
 * text, or after a cancellation), a duplicate success block, an anchor out of
 * order, a missing anchor, extra text on a token line, a stray prose line
 * between the anchors, a wrong prefix, and a value that does not match the token
 * shape. It never logs any input byte and never puts any input byte into a
 * thrown error. The parser is a pure function.
 */
export function parseSetupTokenCredential(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = stripTerminalControls(text);
  const lines = clean.split("\n");

  const beforeIndex = singleAnchorIndex(lines, SETUP_TOKEN_BEFORE_ANCHOR);
  const afterIndex = singleAnchorIndex(lines, SETUP_TOKEN_AFTER_ANCHOR);
  if (beforeIndex === null || afterIndex === null) return null;
  if (afterIndex <= beforeIndex) return null;

  // Read only the non-blank lines strictly between the two anchors. Each line
  // must be one token fragment. A stray prose line, or extra text on a token
  // line, fails the fragment test and the parser returns null.
  const fragments: string[] = [];
  for (let i = beforeIndex + 1; i < afterIndex; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    if (!TOKEN_FRAGMENT_RE.test(trimmed)) return null;
    fragments.push(trimmed);
  }
  if (fragments.length === 0) return null;

  const token = fragments.join("");
  if (!FULL_TOKEN_RE.test(token)) return null;
  return token;
}
