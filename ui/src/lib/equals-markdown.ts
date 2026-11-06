import { isEscaped, rewriteMarkdownProse } from "./underscore-markdown";

/**
 * MDXEditor's `==highlight==` extension (`mdast-util-highlight-mark`) marks
 * every `=` in prose as unsafe, so the exporter stores `a=b` as `a\=b` and
 * `() => x` as `()\=> x`. Stored text feeds agent prompts, so a pasted command
 * or snippet reaches the agent with backslashes the person never typed.
 *
 * A highlight opens or closes only on a run of exactly two `=`, and a two-run
 * with whitespace (or the text edge) on both sides can do neither. Escapes on
 * any other run cannot change how the text parses, so they are removed. Code
 * spans, code blocks and raw HTML stay byte-identical, as do escaped
 * backslashes (`\\=`).
 */
const ESCAPED_EQUALS_RUN_RE = /(?:\\=)+/g;

function unescapeProse(text: string): string {
  return text.replace(ESCAPED_EQUALS_RUN_RE, (run: string, offset: number, whole: string) => {
    if (isEscaped(whole, offset)) return run;
    const length = run.length / 2;
    const before = whole[offset - 1];
    const after = whole[offset + run.length];
    // A neighbouring literal `=` would join this run into a different length.
    if (before === "=" || after === "=") return run;
    const spaced = (char: string | undefined) => char === undefined || /\s/u.test(char);
    if (length === 2 && !(spaced(before) && spaced(after))) return run;
    return "=".repeat(length);
  });
}

export function unescapeEqualsSigns(markdown: string): string {
  if (!markdown.includes("\\=")) return markdown;
  return rewriteMarkdownProse(markdown, unescapeProse);
}
