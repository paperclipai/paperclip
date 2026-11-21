/**
 * The rich markdown editor mounts MDXEditor with `suppressHtmlProcessing`, which
 * strips the HTML visitor out of the import pipeline. Anything the markdown
 * parser tokenizes as an HTML construct therefore arrives with no visitor able
 * to handle it and throws `UnrecognizedMarkdownConstructError`, dropping the
 * whole component into its raw-source fallback.
 *
 * The parser opens an HTML construct on a bare `<` followed by a letter, `!`,
 * `/` or `?` — which is ordinary prose, not markup: a `<name>` placeholder, an
 * inline `</close>`, an `<!-- note -->`. `escapeUnsupportedAngleBrackets`
 * rewrites exactly those `<` to `\<` on the way into the editor so the parser
 * sees literal text, and `unescapeAngleBracketEscapes` reverses it on the way
 * out so the stored value keeps its clean, human-authored form. These fields
 * feed agent prompts, so the escape is a transport detail that must never
 * survive into storage.
 *
 * The pair is byte-lossless across the editor's own parse/serialize round trip:
 * `mdast-util-to-markdown` re-escapes `<` to `\<` in precisely the contexts
 * escaped here, and in no others (`<=` stays bare; code spans and code blocks
 * are never escaped).
 *
 * One deliberate normalization: markdown that *already* contains `\<name>` is
 * left alone on the way in and comes back out as `<name>`, because both forms
 * mean the same literal text and the clean form is what this product stores.
 * That only happens when the user actually edits the field.
 *
 * Contexts skipped, because the parser does not open an HTML construct there
 * and rewriting would corrupt the content:
 *   - fenced code blocks (including fences carried by blockquote/list prefixes)
 *   - indented code blocks
 *   - inline code spans (matched backtick runs only — an unmatched or
 *     backslash-escaped backtick is literal text and protects nothing)
 *   - autolinks: `<scheme:...>` and `<user@host>`
 *   - pointed-bracket link destinations: `](<...>)`
 *   - an already-escaped `\<`
 *
 * Fence tracking mirrors `blockquote-markdown.ts`. The two scanners stay
 * separate on purpose: that one only inspects the leading marker of a line,
 * while this one has to classify every line as code or inline content and then
 * walk the inline runs character by character.
 */

import { createMarkdownFenceTracker, stripTrailingCr } from "./markdown-fence";

/** Characters that make the markdown parser treat a `<` as opening HTML. */
const HTML_OPENER_RE = /[A-Za-z!/?]/;

/** Blockquote container markers, stripped before measuring block indent. */
const BLOCKQUOTE_PREFIX_RE = /^ {0,3}(?:> ?)+/;
/** Four spaces or a tab: the indent that opens a CommonMark indented code block. */
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

// CommonMark autolinks. The scheme needs 2–32 characters, which is why `<x:y>`
// is not an autolink (it is also not HTML, so escaping it is harmless).
const AUTOLINK_URI_RE = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*>/;
const AUTOLINK_EMAIL_RE =
  /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/;
/** A pointed-bracket link destination may hold spaces but never `<` or `>`. */
const POINTED_DESTINATION_RE = /^<[^<>\r\n]*>/;

type Mode = "escape" | "unescape";

function isHtmlOpener(char: string | undefined): boolean {
  return char !== undefined && HTML_OPENER_RE.test(char);
}

/**
 * Index just past the backtick run that closes a code span opened at
 * `contentStart` with `runLength` backticks, or -1 when nothing closes it.
 *
 * Only a run of exactly the same length closes the span, and backslashes are
 * literal inside a code span — so the closing scan must not skip a backtick
 * that happens to follow one.
 */
function findCodeSpanEnd(text: string, contentStart: number, runLength: number): number {
  let i = contentStart;

  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (text[i + run] === "`") run += 1;
    if (run === runLength) return i + run;
    i += run;
  }

  return -1;
}

/**
 * The non-HTML constructs a `<` can open: an autolink, or a pointed-bracket
 * link destination. Returns the whole construct, or null when the `<` opens
 * neither.
 *
 * Both modes consult this one definition on purpose. Escape mode leaves these
 * brackets bare, so unescape mode must refuse to *create* one — otherwise the
 * pair is not an inverse, and an author's escaped `\<https://x>` would silently
 * become a live link the first time the document is edited.
 *
 * `rest` starts at the `<`. `emitted` is the output so far, whose tail is what
 * identifies a link destination.
 */
function matchProtectedConstruct(rest: string, emitted: string): string | null {
  const autolink = AUTOLINK_URI_RE.exec(rest) ?? AUTOLINK_EMAIL_RE.exec(rest);
  if (autolink) return autolink[0];

  if (emitted.endsWith("](")) {
    const destination = POINTED_DESTINATION_RE.exec(rest);
    if (destination) return destination[0];
  }

  return null;
}

/**
 * Walk one run of inline content (one or more consecutive non-code lines) and
 * rewrite the angle brackets the parser would treat as HTML.
 */
function transformInlineChunk(text: string, mode: Mode): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === "`") {
      let run = 1;
      while (text[i + run] === "`") run += 1;
      const end = findCodeSpanEnd(text, i + run, run);
      if (end !== -1) {
        // A matched code span: its contents are literal, copy them through.
        out += text.slice(i, end);
        i = end;
        continue;
      }
      // An unmatched run is ordinary text and protects nothing after it.
      out += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (char === "\\") {
      if (
        mode === "unescape"
        && text[i + 1] === "<"
        && isHtmlOpener(text[i + 2])
        && matchProtectedConstruct(text.slice(i + 1), out) === null
      ) {
        out += "<";
        i += 2;
        continue;
      }
      // Copy the escape pair through untouched. This is what keeps backslash
      // parity intact: `\\<name>` is a literal backslash followed by markup, so
      // the `<` after it is still eligible for escaping, while the `<` in an
      // already-escaped `\<name>` is skipped.
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (mode === "escape" && char === "<" && isHtmlOpener(text[i + 1])) {
      const protectedConstruct = matchProtectedConstruct(text.slice(i), out);
      if (protectedConstruct) {
        out += protectedConstruct;
        i += protectedConstruct.length;
        continue;
      }

      out += "\\<";
      i += 1;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

function transformAngleBrackets(markdown: string, mode: Mode): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let chunk: string[] = [];

  const flushChunk = () => {
    if (chunk.length === 0) return;
    out.push(transformInlineChunk(chunk.join("\n"), mode));
    chunk = [];
  };

  const fenceTracker = createMarkdownFenceTracker();
  let paragraphOpen = false;

  for (const line of lines) {
    if (fenceTracker.step(line)) {
      flushChunk();
      out.push(line);
      paragraphOpen = false;
      continue;
    }

    const content = stripTrailingCr(line).replace(BLOCKQUOTE_PREFIX_RE, "");

    if (content.trim().length === 0) {
      flushChunk();
      out.push(line);
      paragraphOpen = false;
      continue;
    }

    if (!paragraphOpen && INDENTED_CODE_RE.test(content)) {
      flushChunk();
      out.push(line);
      continue;
    }

    paragraphOpen = true;
    chunk.push(line);
  }

  flushChunk();
  return out.join("\n");
}

/**
 * Rewrite `<` to `\<` wherever the markdown parser would otherwise open an HTML
 * construct, leaving code, autolinks, link destinations and existing escapes
 * untouched. Idempotent.
 */
export function escapeUnsupportedAngleBrackets(markdown: string): string {
  if (!markdown.includes("<")) return markdown;
  return transformAngleBrackets(markdown, "escape");
}

/**
 * The inverse of {@link escapeUnsupportedAngleBrackets}: drop the backslash
 * from `\<` wherever it only exists to hide an HTML construct from the parser.
 *
 * An escape is kept when removing it would open an autolink or a pointed link
 * destination, because those are constructs the escape half deliberately leaves
 * bare — unescaping one would turn an author's literal `\<https://x>` into a
 * live link rather than reversing anything. Idempotent.
 */
export function unescapeAngleBracketEscapes(markdown: string): string {
  if (!markdown.includes("\\<")) return markdown;
  return transformAngleBrackets(markdown, "unescape");
}
