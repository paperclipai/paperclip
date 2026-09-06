export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

const SECRET_NAME_PATTERN = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` +
    "`" +
    String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(?:(\\["'])([\s\S]*?)\2|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\4|([^\s"'` +
    "`" +
    String.raw`]+))`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE =
  /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
// A secret-bearing header names a credential in its own header name. The public
// Paperclip API documents `X-API-Key`, and a run log can also carry `Api-Key`,
// `X-Auth-Token`, `X-Paperclip-Api-Key`, or a bare `Authorization`. This rule
// redacts the value of such a header wherever it appears in command text.
//
// A header name is either a hyphenated or underscored word carrying an api-key,
// token, secret, or auth hint, or one of the bare names `authorization` and
// `apikey`. Requiring the hinted form to open with an alphanumeric run and then
// a `-` or `_` keeps the rule off prose and paths that merely contain a hint
// word, such as `GET /v1/tokens:list` or `auth: failed`, and keeps a match from
// opening at the hyphen inside a longer name. `www-authenticate` and
// `proxy-authenticate` are excluded: they are response headers whose
// `error="invalid_token"` parameters are diagnostics worth keeping.
//
// The scheme list follows the IANA HTTP Authentication Scheme Registry as of
// the RFC 9729 `Concealed` addition, plus `AWS4-HMAC-SHA256`, `Hawk`, and
// `Token`, which are widely used but unregistered. A longer alternative
// precedes a shorter one that shares its prefix.
const COMMAND_AUTH_SCHEMES = [
  "AWS4-HMAC-SHA256",
  "Basic",
  "Bearer",
  "Concealed",
  "Digest",
  "DPoP",
  "GNAP",
  "Hawk",
  "HOBA",
  "Mutual",
  "Negotiate",
  "OAuth",
  "PrivateToken",
  "SCRAM-SHA-256",
  "SCRAM-SHA-1",
  "Token",
  "vapid",
] as const;
const COMMAND_SECRET_HEADER_HINT_PATTERN = String.raw`(?:api[-_]?key|token|secret|auth)`;
const COMMAND_SECRET_HEADER_NAME_PATTERN =
  String.raw`(?!(?:www|proxy)-authenticate\b)(?:(?=[A-Za-z0-9]+[-_])[A-Za-z0-9_-]*${COMMAND_SECRET_HEADER_HINT_PATTERN}[A-Za-z0-9_-]*|authorization|apikey)`;
const COMMAND_SECRET_HEADER_COLON_PATTERN = String.raw`[ \t]*:[ \t]*`;
const COMMAND_SECRET_HEADER_SCHEME_PATTERN =
  String.raw`(?:(?:${COMMAND_AUTH_SCHEMES.join("|")})[ \t]+)?`;
// The candidate detector. Everything after it is scanned in code: the header
// name, its colon, and an optional auth scheme are the only part of the rule a
// regular expression can decide on its own.
const COMMAND_SECRET_HEADER_CANDIDATE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?:${COMMAND_SECRET_HEADER_NAME_PATTERN})${COMMAND_SECRET_HEADER_COLON_PATTERN}${COMMAND_SECRET_HEADER_SCHEME_PATTERN}`,
  "gi",
);
// A scheme may also follow the value's own escaped-quote delimiter, as in
// `Authorization:\"Digest username=...\"`. An optional auth scheme stays in the
// output: it is not a secret, and it tells a reader which credential form the
// command used. This also makes the rule agree with the bearer rule above for a
// well-formed bearer header.
const COMMAND_SECRET_HEADER_SCHEME_AT_RE = new RegExp(
  String.raw`(?:${COMMAND_AUTH_SCHEMES.join("|")})[ \t]+`,
  "iy",
);

// ---------------------------------------------------------------------------
// The header-value scanner
// ---------------------------------------------------------------------------
//
// CONTRACT: union over readings, never a guess.
//
// Command text is untrusted and arrives at an unknown serialization depth. At
// depth 0 it is shell text, where `\` escapes and `"` quotes. At depth n it
// sits inside n JSON strings, where every layer doubles each backslash and
// escapes each quote, so one shell `"` reads as a run of `2^n - 1` backslashes
// followed by `"` and one shell `\` reads as a run of `2^n` backslashes. The
// two readings give the same bytes opposite meanings, which is why no single
// pattern can decide where a header value ends.
//
// The scanner therefore does not decide. For each candidate it enumerates the
// plausible readings of the surrounding text, scans the header's shell word
// once per reading, and redacts the UNION of the spans — the longest end. A
// reading that disagrees can only make the redaction longer, so disagreement
// over-redacts and never leaks. Two consequences are deliberate and are not
// bugs: a quote whose open/close state cannot be known locally may swallow a
// following argument, and a serialized string truncated inside the header
// argument loses its outer JSON quote. Both remove text; neither preserves a
// credential byte.
//
// The union cannot leak because: the depth-0 reading is a member of every
// reading set, so a malformed serialized run always has the shell reading to
// fall back on; the consumed span is the maximum end over the set; and the only
// input bytes copied into the output are the header prefix and the value's own
// opening delimiter, both of which end before the value starts. Closing
// delimiters are written as fixed delimiter strings rather than sliced out of
// the input.
//
// A reading is parameterised by one number, `run`: the length of the backslash
// run that spells one quote at that serialization layer. `run = 0` is depth-0
// shell text; `run = 1, 3, 7, 15` are JSON depths 1 to 4. With `unit = run + 1`
// backslashes per decoded backslash, a raw run of `L` backslashes followed by
// `"` decodes to `q = (L - run) / unit` shell backslashes and a shell quote:
// an even `q` leaves the quote unescaped and it delimits, an odd `q` escapes it
// and it stays inside the value. `run = 0` gives `q = L`, which is exactly the
// depth-0 shell rule, so one code path serves every layer. A run that does not
// divide is malformed and is read as an escaped quote, which keeps the value
// running. A bare quote can never appear inside serialized text, so at
// `run > 0` it is the enclosing serializer's own delimiter and ends that
// reading there.
//
// The value is the rest of the header's shell word, so a multi-part credential
// stays covered end to end. A shell word concatenates segments: an unquoted
// run, a double-quoted part, a single-quoted part, an ANSI-C `$'...'` part, and
// a backslash escape pair all join into one argument. Whitespace and a shell
// metacharacter end the word once a segment has closed, so the following
// argument survives. A quoted segment with no closer on its line runs to the
// end of the line, because a truncated run log writes an argument whose closing
// quote never arrives.
//
// The first segment of an unquoted value is read in raw mode instead: a
// comma-separated `key=value` parameter list, the shape a `Digest`,
// `Concealed`, or `AWS4-HMAC-SHA256` credential takes, or else a token bounded
// only by whitespace, a quote, a backtick, or a backslash. A raw HTTP
// diagnostic carries an opaque credential, so a `;`, `|`, or `&` inside that
// token is a credential byte rather than a command separator. Only a
// continuation segment stops at one.
//
// Each candidate emits one placeholder: the header prefix byte for byte, the
// value's own opening delimiter when the value was quoted after the colon, the
// placeholder, the value's own closing delimiter when the winning reading found
// one, and the header argument's closing delimiter when the winning reading
// found one. Everything else the scan consumed is dropped. Every output fed
// back through the rule is byte-identical, which the caller's chain relies on.
const COMMAND_SHELL_METACHARACTERS = new Set([
  ";",
  "|",
  "&",
  "<",
  ">",
  "(",
  ")",
  "`",
]);
// The serialization layers a reading may assume for a value whose delimiter
// does not name one: depth 0 through depth 4.
const COMMAND_SECRET_HEADER_READING_RUNS = [0, 1, 3, 7, 15] as const;

type CommandDelimiterKind = "double" | "single" | "ansi" | "escaped";

interface CommandDelimiter {
  kind: CommandDelimiterKind;
  /** Backslash run that spells this delimiter's quote; 0 for a bare quote. */
  run: number;
  /** Index just past the delimiter. */
  end: number;
}

type CommandTokenKind =
  | "char"
  | "quote"
  | "ansiOpen"
  | "lineContinuation"
  | "space"
  | "newline"
  | "metacharacter"
  | "serializerEnd"
  | "end";

interface CommandToken {
  kind: CommandTokenKind;
  /** The quote character for a `quote` token. */
  quote?: string;
  start: number;
  next: number;
}

/**
 * Decode one shell-level token at `index` under the reading `run`.
 *
 * The decoder collapses a whole backslash run at once, which is what makes the
 * depth-0 and serialized readings share a code path and what keeps the scan
 * linear: every token advances the index past the run it consumed.
 */
function readCommandToken(
  text: string,
  index: number,
  run: number,
): CommandToken {
  if (index >= text.length) return { kind: "end", start: index, next: index };
  const character = text[index]!;
  if (character === "\\") {
    let cursor = index;
    while (cursor < text.length && text[cursor] === "\\") cursor += 1;
    const runLength = cursor - index;
    const unit = run + 1;
    if (text[cursor] === '"') {
      const offset = runLength - run;
      const quotes =
        offset >= 0 && offset % unit === 0 ? offset / unit : Number.NaN;
      // An even count of decoded backslashes leaves the quote unescaped, so it
      // delimits. An odd count, or a run this layer cannot have written,
      // escapes it and the value runs on past it.
      if (Number.isInteger(quotes) && quotes % 2 === 0) {
        return { kind: "quote", quote: '"', start: index, next: cursor + 1 };
      }
      return { kind: "char", start: index, next: cursor + 1 };
    }
    const decoded = Math.floor(runLength / unit);
    if (decoded % 2 === 1) {
      if (cursor >= text.length) {
        return { kind: "char", start: index, next: cursor };
      }
      const escaped = text[cursor]!;
      if (escaped === "\n") {
        return { kind: "lineContinuation", start: index, next: cursor + 1 };
      }
      if (escaped === "\r") {
        return {
          kind: "lineContinuation",
          start: index,
          next: text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1,
        };
      }
      return { kind: "char", start: index, next: cursor + 1 };
    }
    return { kind: "char", start: index, next: cursor };
  }
  if (character === '"') {
    if (run > 0) return { kind: "serializerEnd", start: index, next: index + 1 };
    return { kind: "quote", quote: '"', start: index, next: index + 1 };
  }
  if (character === "'") {
    return { kind: "quote", quote: "'", start: index, next: index + 1 };
  }
  if (character === "$" && text[index + 1] === "'") {
    return { kind: "ansiOpen", start: index, next: index + 2 };
  }
  if (character === "\n" || character === "\r") {
    return { kind: "newline", start: index, next: index };
  }
  if (character === " " || character === "\t") {
    return { kind: "space", start: index, next: index + 1 };
  }
  if (COMMAND_SHELL_METACHARACTERS.has(character)) {
    return { kind: "metacharacter", start: index, next: index + 1 };
  }
  return { kind: "char", start: index, next: index + 1 };
}

interface CommandBodyScan {
  /** Index just past the closer, or the index the truncated body stopped at. */
  end: number;
  closed: boolean;
}

/**
 * Scan the body of a double-quoted part, whether it is a bare `"..."` at depth
 * 0 or a `\"...\"` argument at any serialization depth. Escape pairs and
 * backslash-newline continuations stay inside; a line break or the end of the
 * input truncates the body.
 */
function scanCommandDoubleQuotedBody(
  text: string,
  index: number,
  run: number,
): CommandBodyScan {
  let cursor = index;
  for (;;) {
    const token = readCommandToken(text, cursor, run);
    if (token.kind === "quote" && token.quote === '"') {
      return { end: token.next, closed: true };
    }
    if (
      token.kind === "end" ||
      token.kind === "newline" ||
      token.kind === "serializerEnd"
    ) {
      return { end: token.start, closed: false };
    }
    cursor = token.next;
  }
}

/** Scan the body of an ANSI-C `$'...'` part, which has escapes of its own. */
function scanCommandAnsiQuotedBody(
  text: string,
  index: number,
  run: number,
): CommandBodyScan {
  let cursor = index;
  for (;;) {
    const token = readCommandToken(text, cursor, run);
    if (token.kind === "quote" && token.quote === "'") {
      return { end: token.next, closed: true };
    }
    if (
      token.kind === "end" ||
      token.kind === "newline" ||
      token.kind === "serializerEnd"
    ) {
      return { end: token.start, closed: false };
    }
    cursor = token.next;
  }
}

/**
 * Scan the body of a single-quoted part. A shell single quote has no escapes,
 * so the backslash is an ordinary byte here and only the closing quote, a line
 * break, or the enclosing serializer's own delimiter ends the body.
 */
function scanCommandSingleQuotedBody(
  text: string,
  index: number,
  run: number,
): CommandBodyScan {
  let cursor = index;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === "'") return { end: cursor + 1, closed: true };
    if (character === "\n" || character === "\r") {
      return { end: cursor, closed: false };
    }
    if (character === '"' && run > 0) {
      let back = cursor - 1;
      let runLength = 0;
      while (back >= 0 && text[back] === "\\") {
        runLength += 1;
        back -= 1;
      }
      const offset = runLength - run;
      if (offset < 0 || offset % (run + 1) !== 0) {
        return { end: cursor, closed: false };
      }
    }
    cursor += 1;
  }
  return { end: cursor, closed: false };
}

function scanCommandQuotedBody(
  text: string,
  index: number,
  run: number,
  kind: CommandDelimiterKind,
): CommandBodyScan {
  if (kind === "single") return scanCommandSingleQuotedBody(text, index, run);
  if (kind === "ansi") return scanCommandAnsiQuotedBody(text, index, run);
  return scanCommandDoubleQuotedBody(text, index, run);
}

/**
 * Continue a shell word after its first segment. Segments concatenate, so a
 * quoted part joins the same argument; whitespace, a metacharacter, a line
 * break, or the serializer's own delimiter ends it. A quoted part with no
 * closer on the line is a truncated log line and ends the word at the line end.
 */
function scanCommandWordTail(text: string, index: number, run: number): number {
  let cursor = index;
  for (;;) {
    const token = readCommandToken(text, cursor, run);
    if (
      token.kind === "end" ||
      token.kind === "newline" ||
      token.kind === "space" ||
      token.kind === "metacharacter" ||
      token.kind === "serializerEnd" ||
      token.kind === "lineContinuation"
    ) {
      return token.start;
    }
    if (token.kind === "quote" || token.kind === "ansiOpen") {
      const kind: CommandDelimiterKind =
        token.kind === "ansiOpen"
          ? "ansi"
          : token.quote === "'"
            ? "single"
            : "double";
      const body = scanCommandQuotedBody(text, token.next, run, kind);
      // A segment with no closer on its line is a cut log line and its bytes
      // belong to the word. A cut that leaves the segment empty carries no
      // bytes at all, so the word ends before the quote and the quote stays:
      // redacting it would only make the rule's own output move again.
      if (!body.closed) {
        return body.end === token.next ? token.start : body.end;
      }
      cursor = body.end;
      continue;
    }
    cursor = token.next;
  }
}

// A raw first segment is bounded only by whitespace, a quote, a backtick, or a
// backslash. A metacharacter inside it is a credential byte. The word tail
// takes over at the boundary, which is what lets an unquoted value open on an
// escape pair such as `X-API-Key:\ abc`.
function scanCommandRawSegment(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (
      character === "\n" ||
      character === "\r" ||
      character === " " ||
      character === "\t" ||
      character === "\\" ||
      character === '"' ||
      character === "'" ||
      character === "`"
    ) {
      return cursor;
    }
    if (character === "$" && text[cursor + 1] === "'") return cursor;
    cursor += 1;
  }
  return cursor;
}

const COMMAND_SECRET_HEADER_PARAM_NAME_RE = /[^\s"'`\\,=]+/y;
const COMMAND_SECRET_HEADER_PARAM_DOUBLE_RE = /"(?:\\.|[^"\\\r\n])*"/y;
const COMMAND_SECRET_HEADER_PARAM_SINGLE_RE = /'(?:\\.|[^'\\\r\n])*'/y;
const COMMAND_SECRET_HEADER_PARAM_BARE_RE = /[^\s"'`\\,]*/y;
const COMMAND_SECRET_HEADER_PARAM_SEPARATOR_RE = /[ \t]*,[ \t]*/y;

/**
 * Scan one `key=value` authentication parameter. A parameter written as an HTTP
 * quoted-string carries quoted-pairs and still rejects a raw line break. A
 * continuation parameter must itself carry an `=`, so a bare word after the
 * last parameter (`... response="r" status=401`) survives.
 */
function scanCommandAuthParameter(text: string, index: number): number | null {
  COMMAND_SECRET_HEADER_PARAM_NAME_RE.lastIndex = index;
  if (!COMMAND_SECRET_HEADER_PARAM_NAME_RE.exec(text)) return null;
  let cursor = COMMAND_SECRET_HEADER_PARAM_NAME_RE.lastIndex;
  if (text[cursor] !== "=") return null;
  cursor += 1;
  for (const pattern of [
    COMMAND_SECRET_HEADER_PARAM_DOUBLE_RE,
    COMMAND_SECRET_HEADER_PARAM_SINGLE_RE,
  ]) {
    pattern.lastIndex = cursor;
    if (pattern.exec(text)) return pattern.lastIndex;
  }
  COMMAND_SECRET_HEADER_PARAM_BARE_RE.lastIndex = cursor;
  COMMAND_SECRET_HEADER_PARAM_BARE_RE.exec(text);
  return COMMAND_SECRET_HEADER_PARAM_BARE_RE.lastIndex;
}

function scanCommandAuthParameterList(
  text: string,
  index: number,
): number | null {
  let end = scanCommandAuthParameter(text, index);
  if (end === null) return null;
  for (;;) {
    COMMAND_SECRET_HEADER_PARAM_SEPARATOR_RE.lastIndex = end;
    if (!COMMAND_SECRET_HEADER_PARAM_SEPARATOR_RE.exec(text)) return end;
    const next = scanCommandAuthParameter(
      text,
      COMMAND_SECRET_HEADER_PARAM_SEPARATOR_RE.lastIndex,
    );
    if (next === null) return end;
    end = next;
  }
}

/** Scan an unquoted value: a raw first segment, then the rest of the word. */
function scanCommandUnquotedValue(
  text: string,
  index: number,
  run: number,
): number {
  let end = scanCommandWordTail(text, scanCommandRawSegment(text, index), run);
  if (run === 0) {
    const parameters = scanCommandAuthParameterList(text, index);
    if (parameters !== null) {
      const withTail = scanCommandWordTail(text, parameters, run);
      if (withTail > end) end = withTail;
    }
  }
  return end;
}

/**
 * Read the delimiter immediately before the header name: the opener of the
 * argument the header sits in, if it has one.
 */
function readCommandHeaderOpener(
  text: string,
  nameStart: number,
): CommandDelimiter | null {
  const previous = text[nameStart - 1];
  if (previous === '"') {
    let back = nameStart - 2;
    let runLength = 0;
    while (back >= 0 && text[back] === "\\") {
      runLength += 1;
      back -= 1;
    }
    // An odd run is an escaped quote written by a serializer; an even run is
    // escaped backslashes before a quote that is bare at depth 0.
    if (runLength % 2 === 1) {
      return { kind: "escaped", run: runLength, end: nameStart };
    }
    return { kind: "double", run: 0, end: nameStart };
  }
  if (previous === "'") {
    if (text[nameStart - 2] === "$") {
      return { kind: "ansi", run: 0, end: nameStart };
    }
    return { kind: "single", run: 0, end: nameStart };
  }
  return null;
}

/** Read the value's own delimiter, the one that follows the colon. */
function readCommandValueDelimiter(
  text: string,
  index: number,
): CommandDelimiter | null {
  const character = text[index];
  if (character === '"') return { kind: "double", run: 0, end: index + 1 };
  if (character === "'") return { kind: "single", run: 0, end: index + 1 };
  if (character === "$" && text[index + 1] === "'") {
    return { kind: "ansi", run: 0, end: index + 2 };
  }
  if (character === "\\") {
    let cursor = index;
    while (text[cursor] === "\\") cursor += 1;
    const runLength = cursor - index;
    if (text[cursor] === '"' && runLength % 2 === 1) {
      return { kind: "escaped", run: runLength, end: cursor + 1 };
    }
  }
  return null;
}

function commandDelimiterCloser(delimiter: CommandDelimiter): string {
  if (delimiter.kind === "single" || delimiter.kind === "ansi") return "'";
  if (delimiter.kind === "escaped") return `${"\\".repeat(delimiter.run)}"`;
  return '"';
}

/**
 * Continue a quoted body that a second pass over this rule's own output would
 * have opened inside the placeholder, and then finish the word. An empty body
 * carries no bytes, so it does not extend the word.
 */
function continueCommandQuotedBody(
  text: string,
  index: number,
  run: number,
  kind: CommandDelimiterKind,
): number {
  const body = scanCommandQuotedBody(text, index, run, kind);
  if (!body.closed) return body.end === index ? index : body.end;
  return scanCommandWordTail(text, body.end, run);
}

interface CommandHeaderReading {
  end: number;
  closer: string;
}

/**
 * Redact the value of every secret-bearing header in `command`.
 *
 * One placeholder per candidate; the span is the union of the plausible
 * readings, so the rule over-redacts where the readings disagree and never
 * leaves a credential byte behind.
 */
function redactCommandSecretHeaders(
  command: string,
  redactedValue: string,
): string {
  COMMAND_SECRET_HEADER_CANDIDATE_RE.lastIndex = 0;
  let output = "";
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMAND_SECRET_HEADER_CANDIDATE_RE.exec(command)) !== null) {
    const nameStart = match.index;
    const valueStart = nameStart + match[0].length;
    if (nameStart < copied) continue;
    const opener = readCommandHeaderOpener(command, nameStart);
    // The unquoted reading is declined when the name sits immediately after an
    // unescaped quote: there the name is inside a quoted argument the quoted
    // reading already owns.
    const previous = command[nameStart - 1];
    const allowsUnquoted =
      !(previous === '"' || previous === "'") ||
      command[nameStart - 2] === "\\";
    const first = readCommandToken(command, valueStart, opener?.run ?? 0);
    // A value must open with a non-blank character, and an argument's own
    // closing delimiter there means the argument is empty. Either way there is
    // nothing to hide and the text stays byte for byte.
    if (
      first.kind === "end" ||
      first.kind === "newline" ||
      first.kind === "space"
    ) {
      continue;
    }
    if (
      opener !== null &&
      first.kind === "quote" &&
      first.quote === commandDelimiterCloser(opener).slice(-1)
    ) {
      continue;
    }
    const delimiter =
      opener === null ? readCommandValueDelimiter(command, valueStart) : null;
    let bodyStart = delimiter?.end ?? valueStart;
    if (delimiter?.kind === "escaped") {
      COMMAND_SECRET_HEADER_SCHEME_AT_RE.lastIndex = bodyStart;
      if (COMMAND_SECRET_HEADER_SCHEME_AT_RE.exec(command)) {
        bodyStart = COMMAND_SECRET_HEADER_SCHEME_AT_RE.lastIndex;
      }
    }
    const readings: CommandHeaderReading[] = [];
    const bounded = opener ?? delimiter;
    let closerStart: number | null = null;
    if (bounded !== null) {
      const body = scanCommandQuotedBody(
        command,
        bodyStart,
        bounded.run,
        bounded.kind,
      );
      if (body.closed) closerStart = body.end - (bounded.run + 1);
      readings.push({
        end: body.closed
          ? scanCommandWordTail(command, body.end, bounded.run)
          : body.end,
        closer: body.closed ? commandDelimiterCloser(bounded) : "",
      });
    }
    // The unquoted readings. With no delimiter to name a layer, every layer
    // from depth 0 to depth 4 is plausible and each is scanned. With an escaped
    // delimiter, the depth-0 shell reading is always plausible too, because the
    // same bytes are an escape pair carrying a literal quote there. A bare
    // quote cannot appear in serialized text, so a bare delimiter fixes the
    // reading at depth 0 and admits no unquoted alternative of its own.
    const unquotedRuns =
      bounded === null
        ? COMMAND_SECRET_HEADER_READING_RUNS
        : (opener === null ? bounded.kind === "escaped" : allowsUnquoted)
          ? ([0] as const)
          : [];
    for (const run of unquotedRuns) {
      readings.push({
        end: scanCommandUnquotedValue(command, valueStart, run),
        closer: "",
      });
    }
    // The reopened reading: the depth-0 shell text where the closer this rule
    // just found is not a closer at all but an ordinary byte, or the opening
    // quote of a further segment of the same word. It is the reading the rule's
    // own output presents on a second pass, because the placeholder that
    // replaces the value carries no quote, no backslash, and no separator to
    // stop an unquoted scan before the closer. Admitting it here is what makes
    // one pass a fixpoint: whatever a second pass would consume, the first pass
    // has already consumed.
    if (closerStart !== null && unquotedRuns.length > 0) {
      readings.push({
        end: scanCommandWordTail(command, closerStart, 0),
        closer: "",
      });
    }
    let best: CommandHeaderReading | null = null;
    for (const reading of readings) {
      if (
        best === null ||
        reading.end > best.end ||
        (reading.end === best.end && reading.closer.length > best.closer.length)
      ) {
        best = reading;
      }
    }
    if (best === null || best.end <= valueStart) continue;
    // The fixpoint. A second pass reads this rule's own output, where the
    // placeholder has replaced the value: it carries no quote, no backslash and
    // no separator, so a scan that crosses it arrives at the text after the
    // span in a state the first pass never reached. Consuming now whatever such
    // a scan would consume makes one pass settle, which the caller's chain
    // requires. Each round starts where the last stopped and the rounds cover
    // disjoint text, so the loop stays linear.
    //
    // This rests on `redactedValue` carrying no quote, backslash, whitespace,
    // backtick or shell metacharacter, which is what makes a scan cross it
    // rather than stop inside it. Every caller passes `***REDACTED***`. A
    // placeholder holding any of those bytes would stop one reading and not
    // another, and the rule's output could move on a second pass.
    for (;;) {
      let grown: number = best.end;
      const consider = (candidate: number) => {
        if (candidate > grown) grown = candidate;
      };
      if (bounded !== null) {
        if (best.closer === "") {
          // With no closer written, a second pass hunts the delimiter's closer
          // from inside the placeholder and its body scan spills past the span.
          consider(
            continueCommandQuotedBody(
              command,
              best.end,
              bounded.run,
              bounded.kind,
            ),
          );
        } else {
          consider(scanCommandWordTail(command, best.end, bounded.run));
        }
      }
      if (unquotedRuns.length > 0) {
        if (best.closer === '"' || best.closer === "'") {
          consider(
            continueCommandQuotedBody(
              command,
              best.end,
              0,
              best.closer === "'" ? "single" : "double",
            ),
          );
        } else {
          consider(scanCommandWordTail(command, best.end, 0));
        }
        for (const run of unquotedRuns) {
          consider(scanCommandWordTail(command, best.end, run));
        }
      }
      if (grown <= best.end) break;
      best = { end: grown, closer: best.closer };
    }
    output +=
      command.slice(copied, nameStart) +
      command.slice(nameStart, bodyStart) +
      redactedValue +
      best.closer;
    copied = best.end;
    COMMAND_SECRET_HEADER_CANDIDATE_RE.lastIndex = best.end;
  }
  return output + command.slice(copied);
}
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".")
  );
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  return redactCommandSecretHeaders(
    command.replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`),
    redactedValue,
  )
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(
      COMMAND_ENV_SECRET_ASSIGNMENT_RE,
      (
        _match,
        prefix: string,
        escapedQuote: string | undefined,
        _escapedValue: string | undefined,
        rawQuote: string | undefined,
      ) => {
        const quote = escapedQuote ?? rawQuote;
        return quote
          ? `${prefix}${quote}${redactedValue}${quote}`
          : `${prefix}${redactedValue}`;
      },
    )
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue);
}

// A JSON secret field is a key/value pair such as `"token":"opaque-value"`. The
// command redaction handles shell `KEY=value` syntax only. A sandbox diagnostic
// can also carry a serialized JSON error, so the sanitizer must redact the JSON
// form too. The value body consumes JSON escape sequences. An escaped quote
// (`\"`) inside the value does not end the match early.
const JSON_SECRET_FIELD_RE = new RegExp(
  String.raw`("(?:${SECRET_NAME_PATTERN})"\s*:\s*")(?:\\[\s\S]|[^"\\])*(")`,
  "gi",
);
// An escaped JSON secret field is the same pair inside a JSON string. The double
// quote appears as `\"` and a backslash appears as `\\`. The value body
// consumes the doubled escape sequences. An escaped quote inside the value does
// not end the match early. The value ends at the next unescaped `\"`.
const JSON_ESCAPED_SECRET_FIELD_RE = new RegExp(
  String.raw`(\\"(?:${SECRET_NAME_PATTERN})\\"\s*:\s*\\")(?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*(\\")`,
  "gi",
);

/**
 * Redact secrets from an untrusted diagnostic string.
 *
 * The function first runs the command redaction. The command redaction handles
 * shell `KEY=value` assignments, CLI secret options, bearer headers, and common
 * token shapes. The function then redacts JSON and escaped-JSON secret fields,
 * because a sandbox diagnostic can carry a serialized JSON error such as
 * `{"token":"opaque-value"}`. The caller must still bound the length after this
 * step.
 */
export function redactDiagnosticText(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  return redactCommandText(text, redactedValue)
    .replace(JSON_ESCAPED_SECRET_FIELD_RE, `$1${redactedValue}$2`)
    .replace(JSON_SECRET_FIELD_RE, `$1${redactedValue}$2`);
}
