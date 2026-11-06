import { isEscaped, rewriteMarkdownProse } from "./underscore-markdown";

/**
 * MDXEditor's `==highlight==` extension (`mdast-util-highlight-mark`) marks
 * every `=` in prose as unsafe, so the exporter stores `a=b` as `a\=b` and
 * `() => x` as `()\=> x`. Stored text feeds agent prompts, so a pasted command
 * or snippet reaches the agent with backslashes the person never typed.
 *
 * A highlight opens or closes only on a run of exactly two `=`, and a two-run
 * with whitespace on both sides can do neither. A run that starts a line can
 * underline a heading, so it keeps its escape. Other escapes cannot change how
 * the text parses, so they are removed. Code
 * spans, code blocks and raw HTML stay byte-identical, as do escaped
 * backslashes (`\\=`).
 */
const ESCAPED_EQUALS_RUN_RE = /(?:\\=)+/g;

function unescapeProse(text: string): string {
  // One forward pass: matches arrive in order, so track whether only
  // indentation or quote markers precede the current offset on its line.
  let scanned = 0;
  let lineStartOnly = true;
  return text.replace(ESCAPED_EQUALS_RUN_RE, (run: string, offset: number, whole: string) => {
    for (; scanned < offset; scanned += 1) {
      const char = whole[scanned]!;
      if (char === "\n") lineStartOnly = true;
      else if (char !== ">" && !/\s/u.test(char)) lineStartOnly = false;
    }
    const atLineStart = lineStartOnly;
    scanned = offset + run.length;
    lineStartOnly = false;
    if (isEscaped(whole, offset)) return run;
    // At the start of a line (after indentation or quote markers) a run of `=`
    // can underline the previous line as a heading, so its escape stays. This
    // includes the start of a prose chunk, whose preceding text is unknown.
    if (atLineStart) return run;
    const length = run.length / 2;
    const before = whole[offset - 1];
    const after = whole[offset + run.length];
    // A neighbouring literal `=` would join this run into a different length.
    if (before === "=" || after === "=") return run;
    // A chunk edge borders a code span or block, not whitespace, so it never
    // counts as space around a two-run.
    const spaced = (char: string | undefined) => char !== undefined && /\s/u.test(char);
    if (length === 2 && !(spaced(before) && spaced(after))) return run;
    return "=".repeat(length);
  });
}

export function unescapeEqualsSigns(markdown: string): string {
  if (!markdown.includes("\\=")) return markdown;
  return rewriteMarkdownProse(markdown, unescapeProse);
}
