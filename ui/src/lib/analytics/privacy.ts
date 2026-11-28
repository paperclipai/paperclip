// Shared privacy markers for browser product analytics (PostHog).
//
// Session replay shows text by default and masks ALL input values. Text is
// masked only inside customer content marked with `ANALYTICS_MASK_CLASS`,
// inside secrets marked with `ANALYTICS_NO_CAPTURE_CLASS` (blocked entirely),
// inside editable content, and inside work content marked with
// `ANALYTICS_WORK_CONTENT_CLASS` unless the company holds no Google or Slack
// data. Autocapture never records element text or
// attribute values at all (see `product-analytics.ts`).
//
// Apply these markers instead of PostHog class names, so `product-analytics.ts`
// stays the one place that knows about PostHog. They have no effect when
// analytics is off (self-hosted and local installs).

import { redactUrlSecrets } from "@/lib/redact-url-secrets";

/**
 * Customer content: comments, chat messages, run output, connected-account
 * data and anything else that is not work content (see
 * `ANALYTICS_WORK_CONTENT_CLASS`). Session replay always masks its text, and
 * autocapture records nothing from inside it.
 */
export const ANALYTICS_MASK_CLASS = "ph-mask ph-sensitive";

/**
 * Secrets and credentials: API keys, tokens, passwords, environment values.
 * Session replay records a blank placeholder instead of the element and its
 * children, and autocapture records nothing from inside it.
 */
export const ANALYTICS_NO_CAPTURE_CLASS = "ph-no-capture";

/**
 * Work content: task descriptions, document bodies and artifact contents.
 * Secrets inside it stay masked (`redactReplaySecrets`). Session replay masks
 * all of it unless the page says the active company holds no Google or Slack
 * data (`REPLAY_WORK_CONTENT_ATTRIBUTE` on `<html>`, set by
 * `ReplayWorkContentVisibility`). Agents copy connected-account content into
 * these surfaces, and our privacy policy and the Google API Limited Use rules
 * say no person may read that content in a replay.
 *
 * A strict marker inside work content still wins: `ANALYTICS_MASK_CLASS`,
 * `ANALYTICS_NO_CAPTURE_CLASS` and editors stay masked (see `maskReplayText`).
 */
export const ANALYTICS_WORK_CONTENT_CLASS = "ph-work-content";

/** `<html>` attribute that shows work content in replays when set to `"visible"`. */
export const REPLAY_WORK_CONTENT_ATTRIBUTE = "data-replay-work-content";

/**
 * The marker for work content that is loaded by id and so may belong to
 * another company than the selected one (a task preview on a link). The
 * page's visible flag is the selected company's answer, so only that
 * company's content may use the work content marker. Content of another
 * company, or of an unknown one, is customer content and always masks.
 */
export function workContentClassForCompany(
  contentCompanyId: string | null | undefined,
  selectedCompanyId: string | null | undefined,
): string {
  return contentCompanyId && contentCompanyId === selectedCompanyId ? ANALYTICS_WORK_CONTENT_CLASS : ANALYTICS_MASK_CLASS;
}

/** Markers that always mask, wherever they sit. */
const STRICT_MASK_SELECTOR = [
  ...ANALYTICS_MASK_CLASS.split(" "),
  ANALYTICS_NO_CAPTURE_CLASS,
].map((name) => `.${name}`).concat("[contenteditable]:not([contenteditable=\"false\"])").join(", ");

/**
 * Session replay masks text only inside these markers. Work content is in the
 * selector too, so it fails closed: `maskReplayText` decides whether it shows.
 */
export const ANALYTICS_MASK_TEXT_SELECTOR = `${STRICT_MASK_SELECTOR}, .${ANALYTICS_WORK_CONTENT_CLASS}`;

/** True when the page has confirmed that work content may show in replays. */
export function replayWorkContentVisible(doc: Document | null | undefined = globalThis.document): boolean {
  return doc?.documentElement?.getAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE) === "visible";
}

function maskCharacters(text: string): string {
  return text.replace(/\S/g, "*");
}

/**
 * Words that say a label names a secret, anywhere in the label (`API_KEY`,
 * `dbPassword`, `Client secret`).
 */
const SECRET_NAME_WORD = /api[-_ ]?key|access[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|secret|passw(?:or)?d|passwd|passphrase|pwd|credentials?|private[-_ ]?key|client[-_ ]?secret|session[-_ ]?id|cookie|connection[-_ ]?string|dsn|jwt|bearer/i;

/**
 * Words that say secret only as the last word of a label: `ENCRYPTION_KEY`,
 * `signingKey`, `Key`, `DB_PASS`, `auth`, `PIN`. Elsewhere they are ordinary
 * words ("Key findings: ...", "Pass rate: 98%").
 */
const SECRET_NAME_END = /keys?$|(?:^|[^a-z])(?:pass|auth|pin|otp)$/i;

function labelNamesSecret(label: string): boolean {
  return SECRET_NAME_WORD.test(label) || SECRET_NAME_END.test(label);
}

/**
 * A label and its assignment operator: `NAME=`, `name: `, `"name": `,
 * `name := `, `name => `, `API key: `, `**Password**: `. The label is the
 * last one to four words before the operator. It starts only at the start of
 * a word and each word is one character class, so it stays linear on long
 * input.
 */
const ASSIGNMENT_START = /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+[ \t]){0,3}[A-Za-z0-9_.-]+)["'`*]{0,3}[ \t]*(?::=|=>|[:=])[ \t]*/g;

const QUOTES = new Set(['"', "'", "`"]);

function isLineBreak(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

/**
 * The value that starts at `index`, as the range to mask and the index after
 * it. A quoted value runs to its closing quote (escaped quotes included) or
 * the end of the line; an unquoted value runs to the end of the line, as in
 * YAML. There is no length limit, so a long secret leaves no readable tail.
 */
function secretValueRange(text: string, index: number): { from: number; to: number; end: number } {
  const quote = text[index];
  if (quote !== undefined && QUOTES.has(quote)) {
    let cursor = index + 1;
    while (cursor < text.length && !isLineBreak(text[cursor])) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === quote) return { from: index + 1, to: cursor, end: cursor + 1 };
      cursor += 1;
    }
    const to = Math.min(cursor, text.length);
    return { from: index + 1, to, end: to };
  }
  let cursor = index;
  while (cursor < text.length && !isLineBreak(text[cursor])) cursor += 1;
  return { from: index, to: cursor, end: cursor };
}

/**
 * Masks the whole value of every `name: value` / `name=value` /
 * `"name": "value"` assignment whose label says secret, so
 * `password="correct horse battery staple"` masks in full while the next JSON
 * field and a preceding `user=bob` still show.
 *
 * `nodeStart` and `continues` are for text that follows other text on its
 * line (see `redactReplaySecrets`). A value that began before `nodeStart`
 * masks on through this node in two cases: it is quoted and still open (up to
 * its closing quote, so `Password: "correct **horse** battery"` masks every
 * word while the text after the closing quote shows), or `continues` says an
 * unquoted value runs into this node. Otherwise the value is left to the
 * node it began in. The scan then goes on from the text after its operator,
 * so a later label in the earlier text (`KEY=abc and password: `) still
 * masks this node.
 */
function redactSecretAssignments(text: string, nodeStart: number, continues: (offset: number) => boolean): string {
  const pattern = new RegExp(ASSIGNMENT_START.source, "g");
  let result = "";
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!labelNamesSecret(match[1] ?? "")) continue;
    const valueStart = match.index + match[0].length;
    const range = secretValueRange(text, valueStart);
    if (range.from < nodeStart) {
      const quoted = range.from === valueStart + 1;
      const runsOn = range.to > nodeStart && (quoted || continues(range.from));
      if (!runsOn) {
        // A closed quoted value has a known end. An unquoted one does not, so
        // read on inside it: that can only find more to mask.
        if (quoted) pattern.lastIndex = Math.max(pattern.lastIndex, range.end);
        continue;
      }
    }
    if (range.to > range.from) {
      result += text.slice(copied, range.from) + maskCharacters(text.slice(range.from, range.to));
      copied = range.to;
    }
    pattern.lastIndex = Math.max(range.end, pattern.lastIndex);
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/**
 * A command-line flag whose name says secret, with its value after a space:
 * `--password hunter2`, `--api-key "a b"`, `--db_password x`.
 * (`--password=hunter2` is an assignment.) A quoted value runs to its closing
 * quote, past escaped quotes (`"correct \"horse\" battery"`), or to the end
 * of the line.
 */
const SECRET_FLAG_NAME = /password|passwd|passphrase|pwd|token|secret|api-?key|credential/i;

function redactSecretFlags(text: string): string {
  const names = /--[A-Za-z0-9_-]*/g;
  const values = /"(?:\\[^\n\r]?|[^"\\\n\r])*"?|'(?:\\[^\n\r]?|[^'\\\n\r])*'?|\S+/y;
  let result = "";
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = names.exec(text)) !== null) {
    if (!SECRET_FLAG_NAME.test(match[0])) continue;
    let valueStart = names.lastIndex;
    while (text[valueStart] === " " || text[valueStart] === "\t") valueStart += 1;
    if (valueStart === names.lastIndex) continue;
    values.lastIndex = valueStart;
    const value = values.exec(text);
    if (!value) continue;
    result += text.slice(copied, valueStart) + maskCharacters(value[0]);
    copied = values.lastIndex;
    names.lastIndex = copied;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/** `Authorization: Bearer x`, `Basic x`, `Token x`: the credential is masked. */
const AUTH_SCHEME = /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/g;

/** Credentials inside a URL (`scheme://user:password@host`). */
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@:]+:[^\s/@]+)(@)/gi;

/** Well-known credential formats, masked wherever they appear. */
const KNOWN_TOKEN = new RegExp(
  [
    String.raw`\b(?:sk|rk|pk)[-_](?:live|test|ant|proj|or)?[-_]?[A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
    String.raw`\bya29\.[0-9A-Za-z_-]{20,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)`,
  ].join("|"),
  "g",
);

/**
 * A long run of mixed-case letters and digits, such as a pasted API key in an
 * unknown format. Hex hashes and UUIDs have no uppercase letters, so they show.
 */
const RANDOM_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
}

/** Two redactions of `text` as one: a character is masked when either masks it. */
function mergeMasks(text: string, first: string, second: string): string {
  if (first === second) return first;
  let merged = "";
  for (let index = 0; index < text.length; index += 1) {
    merged += first[index] === text[index] ? second[index] : first[index];
  }
  return merged;
}

/** Every redaction keeps the text length, so a slice of the result lines up with the input. */
function redactSecretsInLine(text: string, nodeStart: number, continues: (offset: number) => boolean): string {
  return redactSecretFlags(redactSecretAssignments(text.replace(KNOWN_TOKEN, maskCharacters), nodeStart, continues))
    .replace(AUTH_SCHEME, (_match, scheme: string, value: string) => `${scheme}${maskCharacters(value)}`)
    .replace(URL_USERINFO, (_match, scheme: string, userinfo: string, at: string) => `${scheme}${maskCharacters(userinfo)}${at}`)
    .replace(RANDOM_TOKEN, (token) => (looksRandom(token) ? maskCharacters(token) : token));
}

/** Text that sits before a text node on its line, for `redactReplaySecrets`. */
export type ReplayLineContext = {
  /** The text before the node on the same line. */
  before: string;
  /**
   * Whether a secret value that starts at this offset of `before` runs on
   * into the node. A value runs to the end of its line (or its closing quote)
   * inside the element it starts in: `Password: "correct **horse** battery"`
   * masks all three nodes, while the sentence after an inline
   * `KEY=value` still shows.
   */
  continues: (offset: number) => boolean;
};

const never = () => false;

/**
 * Masks secrets inside text that is otherwise shown in replays: known key and
 * token formats, `name=value` assignments whose label says secret, secret
 * command-line flags, auth header credentials, URL passwords, private key
 * blocks and long random-looking tokens. Work content can hold a pasted key
 * (a config file, a task description), and the board's no-capture marker only
 * covers fields it renders as secrets.
 *
 * rrweb records one text node at a time, and Markdown and syntax highlighting
 * split a line into several nodes (`**Password:** hunter2`, a value in inline
 * code, a value with bold text inside). `context` carries the text before the
 * node on its line, so a label or an unfinished value in an earlier node
 * still masks this one. Context only adds masking: whatever the text masks by
 * itself stays masked.
 */
export function redactReplaySecrets(text: string, context?: ReplayLineContext): string {
  const alone = redactSecretsInLine(text, 0, never);
  if (!context?.before) return alone;
  const { before } = context;
  const inLine = redactSecretsInLine(before + text, before.length, context.continues).slice(before.length);
  return mergeMasks(text, alone, inLine);
}

/** How much text before a node is read for its label, and how many nodes back. */
const LINE_CONTEXT_MAX_LENGTH = 256;
const LINE_CONTEXT_MAX_NODES = 64;
const MAX_CONTEXT_CANDIDATES = 16;

/** Elements that start a new line, so text before them is not on this line. */
const LINE_BREAK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function startsNewLine(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && LINE_BREAK_TAGS.has(node.nodeName.toUpperCase());
}

/** Decoration that is not part of the line's text, such as a line-number gutter. */
function isHiddenFromText(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && (node as Element).getAttribute("aria-hidden") === "true";
}

/** The last child that counts as text of the line, skipping decoration. */
function lastTextChild(node: Node): Node | null {
  let child = node.lastChild;
  while (child && isHiddenFromText(child)) child = child.previousSibling;
  return child;
}

/** The text before a node on its line, and the text node each part came from. */
type LineBefore = { text: string; parts: Array<{ end: number; node: Text }> };

/**
 * The text before `node` on its line inside `root`: earlier text nodes, back
 * to a line break, a block element or `root`. Bounded, so recording a long
 * line stays linear.
 */
function lineBefore(node: Text, root: Element): LineBefore {
  const found: Array<{ data: string; node: Text }> = [];
  let length = 0;
  let current: Node = node;
  for (let visited = 0; visited < LINE_CONTEXT_MAX_NODES && length < LINE_CONTEXT_MAX_LENGTH; visited += 1) {
    let previous: Node | null = current.previousSibling;
    if (!previous) {
      const parent = current.parentNode;
      if (!parent || parent === root || startsNewLine(parent)) break;
      current = parent;
      continue;
    }
    current = previous;
    if (isHiddenFromText(previous)) continue;
    if (startsNewLine(previous)) break;
    let reachedBlock = false;
    for (let child = lastTextChild(previous); child; child = lastTextChild(previous)) {
      previous = child;
      if (startsNewLine(previous)) {
        reachedBlock = true;
        break;
      }
    }
    if (reachedBlock) break;
    current = previous;
    if (previous.nodeType !== TEXT_NODE) continue;
    const data = (previous as Text).data;
    const lineBreak = Math.max(data.lastIndexOf("\n"), data.lastIndexOf("\r"));
    const onLine = lineBreak >= 0 ? data.slice(lineBreak + 1) : data;
    found.unshift({ data: onLine, node: previous as Text });
    length += onLine.length;
    if (lineBreak >= 0) break;
  }
  // Keep the end of the line when it is longer than the limit.
  const dropped = Math.max(0, length - LINE_CONTEXT_MAX_LENGTH);
  let end = -dropped;
  const parts = found.map((part) => {
    end += part.data.length;
    return { end, node: part.node };
  });
  return { text: found.map((part) => part.data).join("").slice(dropped), parts };
}

/**
 * Lookups that hold for one synchronous run of the recorder (a full snapshot,
 * or one batch of mutations). The DOM cannot change inside such a run, so
 * each parent's text children are indexed once and each key-block answer is
 * reused by the next line. A microtask drops them before the page can change.
 */
type RecordingPass = {
  textChildren: WeakMap<Element, Map<string, Text[]>>;
  inPrivateKey: WeakMap<Text, boolean>;
};

let recordingPass: RecordingPass | null = null;

function currentRecordingPass(): RecordingPass {
  if (!recordingPass) {
    recordingPass = { textChildren: new WeakMap(), inPrivateKey: new WeakMap() };
    queueMicrotask(() => {
      recordingPass = null;
    });
  }
  return recordingPass;
}

/**
 * The child text nodes of `parent` that hold exactly `text`. rrweb passes the
 * text and its parent element, not the node. The index is built once per
 * parent and pass, so a paragraph with thousands of text children stays
 * linear.
 */
function textChildrenWith(parent: Element, text: string): Text[] {
  const pass = currentRecordingPass();
  let byText = pass.textChildren.get(parent);
  if (!byText) {
    byText = new Map();
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== TEXT_NODE) continue;
      const data = (child as Text).data;
      const same = byText.get(data);
      if (same) same.push(child as Text);
      else byText.set(data, [child as Text]);
    }
    pass.textChildren.set(parent, byText);
  }
  return byText.get(text) ?? [];
}

/** The end of an opening or closing marker (`-----BEGIN RSA PRIVATE KEY-----`, PGP's `PRIVATE KEY BLOCK-----`). */
const PRIVATE_KEY_MARKER = /PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

/** Text that can be part of a private key body: base64 and line breaks only. */
const KEY_BODY_TEXT = /^[A-Za-z0-9+/=\s]+$/;

/** A PEM header line between the opening marker and the body. */
const KEY_HEADER_LINE = /^[A-Za-z-]+: \S+$/;

/** A key body is at most a few dozen lines; each line is one or two nodes. */
const PRIVATE_KEY_MAX_NODES = 200;

/** Zero-width spaces stand in for empty lines in the file viewer. */
function visibleText(data: string): string {
  return data.replace(/\u200b/g, "").trim();
}

/**
 * The length of the start of `text` that can be the rest of a private key
 * body: everything before a closing marker, or all of it, when that part is
 * base64 only. Zero when the text cannot continue a key.
 */
function keyBodyPrefixLength(text: string): number {
  const end = text.search(PRIVATE_KEY_END);
  const body = end >= 0 ? text.slice(0, end) : text;
  return visibleText(body) && KEY_BODY_TEXT.test(body) ? body.length : 0;
}

/**
 * True when `node` sits inside a private key block that opened in an earlier
 * node of `root`. The file viewer and syntax highlighting put each line of a
 * key in its own node, so only the opening line matches the key format by
 * itself. Reads back through key body text, header lines and blank lines to
 * the nearest marker, and stops at anything else.
 */
function insidePrivateKeyBlock(node: Text, root: Element): boolean {
  const pass = currentRecordingPass();
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  walker.currentNode = node;
  let inside = false;
  for (let visited = 0; visited < PRIVATE_KEY_MAX_NODES; visited += 1) {
    const previous = walker.previousNode() as Text | null;
    if (!previous) break;
    if (previous.parentElement && isHiddenFromText(previous.parentElement)) continue;
    const data = previous.data;
    if (PRIVATE_KEY_MARKER.test(data)) {
      inside = data.lastIndexOf("-----BEGIN ") > data.lastIndexOf("-----END ");
      break;
    }
    const line = visibleText(data);
    if (!line) continue;
    // The line before was answered in this pass: the same answer holds here.
    const known = pass.inPrivateKey.get(previous);
    if (known !== undefined) {
      inside = known;
      break;
    }
    if (!KEY_BODY_TEXT.test(line) && !KEY_HEADER_LINE.test(line)) break;
  }
  pass.inPrivateKey.set(node, inside);
  return inside;
}

/**
 * Redacts the text of a shown work content node with its line context.
 * rrweb passes the text and its parent element, not the node, so every child
 * text node with this text is a candidate and a character is masked when any
 * candidate masks it.
 */
function redactWorkContentText(text: string, parent: HTMLElement, root: Element): string {
  if (!/\S/.test(text)) return text;
  // Preformatted text: a line is one statement, so a value runs to its end.
  const preformatted = parent.closest("pre") !== null;
  const keyBodyLength = keyBodyPrefixLength(text);
  let result = redactReplaySecrets(text);
  const candidates = textChildrenWith(parent, text);
  // Many identical siblings: do not read context for each, mask the text.
  if (candidates.length > MAX_CONTEXT_CANDIDATES) return maskCharacters(text);
  for (const child of candidates) {
    if (keyBodyLength > 0 && insidePrivateKeyBlock(child, root)) {
      result = mergeMasks(text, result, maskCharacters(text.slice(0, keyBodyLength)) + text.slice(keyBodyLength));
    }
    const line = lineBefore(child, root);
    if (!line.text) continue;
    // Elsewhere a value runs on only inside the element it starts in.
    const continues = (offset: number) => preformatted
      || (line.parts.find((part) => offset < part.end)?.node.parentNode?.contains(child) ?? false);
    result = mergeMasks(text, result, redactReplaySecrets(text, { before: line.text, continues }));
  }
  return result;
}

/**
 * Session replay `maskTextFn`. rrweb calls it only for text inside
 * `ANALYTICS_MASK_TEXT_SELECTOR`. The nearest marker decides: work content
 * shows when the page allows it, with secrets inside it still masked
 * (`redactReplaySecrets`), and every other marker masks. Whitespace stays, so
 * the layout stays readable.
 */
export function maskReplayText(text: string, element?: HTMLElement | null): string {
  const nearest = element?.closest?.(ANALYTICS_MASK_TEXT_SELECTOR);
  if (
    element
    && nearest
    && nearest.classList.contains(ANALYTICS_WORK_CONTENT_CLASS)
    && !nearest.matches(STRICT_MASK_SELECTOR)
    && replayWorkContentVisible(nearest.ownerDocument)
  ) {
    return redactWorkContentText(text, element, nearest);
  }
  return maskCharacters(text);
}

/**
 * Attributes that only describe layout, state or structure. Every other
 * attribute (title, alt, aria-label, placeholder, value, src, href, data-*,
 * and element references such as id, for and aria-labelledby, which often
 * embed names or slugs) can carry customer text, so replay masks it.
 */
const LAYOUT_ATTRIBUTES = new Set([
  "class", "style", "type", "role", "tabindex", "disabled", "checked", "selected", "hidden",
  "open", "dir", "lang", "rel", "target", "colspan", "rowspan", "width", "height",
  "viewbox", "xmlns", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "points", "transform", "opacity",
  "aria-hidden", "aria-expanded", "aria-selected", "aria-checked", "aria-current", "aria-disabled",
  "aria-orientation", "aria-haspopup", "aria-modal", "aria-pressed", "aria-invalid", "aria-live", "aria-busy",
  "data-slot", "data-state", "data-side", "data-align", "data-orientation", "data-variant",
  "data-size", "data-disabled", "data-highlighted", "data-placeholder",
]);

/** Fixed IDs that page CSS targets (`#root`, `#main-content`); never customer data. */
const LAYOUT_IDS = new Set(["root", "main-content", "properties-pane-header-slot"]);

/**
 * Session replay `maskAttributeFn`. Deny by default: only layout attributes,
 * rrweb's own metadata, stylesheets and links outside customer content keep
 * their values. Free-text attributes stay masked everywhere, because labels
 * such as `aria-label` often name customer data (for example the
 * organization switcher's "Open <name> switcher").
 */
export function maskReplayAttribute(name: string, value: string, element?: Element | null): string {
  const key = name.toLowerCase();
  // rrweb's own serialized metadata (`rr_width`, `_cssText`, ...).
  if (key.startsWith("rr_") || key.startsWith("_")) return value;
  if (LAYOUT_ATTRIBUTES.has(key)) return value;
  if (key === "id" && LAYOUT_IDS.has(value)) return value;
  // Stylesheets render the page. Every other `href` (download links carry
  // file paths, markdown links carry customer URLs) stays masked.
  if (key === "href" && element?.tagName?.toLowerCase() === "link") return redactAnalyticsUrl(value);
  return value.replace(/\S/g, "*");
}

/** Routes whose next path segment is a one-time secret (claim and invite links). */
const SECRET_PATH_SEGMENT = /(\/(?:board-claim|invite)\/)[^/?#\s"']+/gi;

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Prepares a URL or path for analytics. Deny by default: a URL keeps only its
 * origin and path, because query and hash values can hold credentials
 * (`token`, `code`, `state`), file paths or search text. The token segment of
 * claim and invite links is redacted. Any other string only has secret
 * `key=value` pairs redacted.
 */
export function redactAnalyticsUrl(value: string): string {
  if (!value.includes("/") && !value.includes("?") && !value.includes("#")) return value;
  const trimmed = value.trim();
  let result: string;
  if (ABSOLUTE_URL.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      result = `${url.origin === "null" ? `${url.protocol}//` : url.origin}${url.pathname}`;
    } catch {
      result = redactUrlSecrets(value);
    }
  } else if (trimmed.startsWith("/")) {
    result = trimmed.replace(/[?#].*$/, "");
  } else {
    result = redactUrlSecrets(value);
  }
  return result.replace(SECRET_PATH_SEGMENT, "$1REDACTED");
}
