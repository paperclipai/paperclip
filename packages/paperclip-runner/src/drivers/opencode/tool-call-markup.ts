/**
 * Some OpenRouter hosts return a model's tool call as the model's raw
 * tool-call syntax inside assistant text instead of as a structured tool call.
 * DeepSeek's DSML block (`<｜DSML｜ calls>` / `<｜DSML｜ invoke name=…>`) is the
 * recorded case. That text is an unexecuted, malformed tool call: it is not
 * prose for the person and must never become the reply.
 *
 * Detection is one linear scan of a single text part. Fenced code blocks are
 * ignored, so an answer that shows such syntax in a code sample is still an
 * answer.
 */

/** Sentinels that never occur in ordinary prose. They count anywhere outside a code fence. */
const SENTINEL_PATTERN = /<[｜|]\s*(?:DSML\s*[｜|]|tool[▁_]calls?[▁_]begin\s*[｜|]>)/;
const SENTINEL_OPENINGS = ["<｜DSML｜", "<|DSML|", "<｜tool▁calls▁begin｜>", "<｜tool▁call▁begin｜>"];
const LONGEST_SENTINEL_OPENING = Math.max(...SENTINEL_OPENINGS.map(opening => opening.length));

/**
 * Generic XML-style tool-call wrappers. They count only at the start of a line
 * and only when a call body follows the wrapper, so prose that names the tag
 * does not match.
 */
const LINE_FORMS = [
  { wrapper: "<function_calls>", body: '<invokename="', pattern: /^<function_calls>\s*<invoke\s+name\s*=/ },
  { wrapper: "<tool_call>", body: '{"name":', pattern: /^<tool_call>\s*\{\s*"name"\s*:/ },
];

const FENCE = /^[ \t]*(?:```|~~~)/;

/** Whether streaming text at a line start could still grow into a generic wrapper with a call body. */
function couldBecomeLineForm(rest: string): boolean {
  const compact = rest.replace(/\s+/g, "");
  if (!compact) return false;
  return LINE_FORMS.some(({ wrapper, body }) =>
    compact.length <= wrapper.length
      ? wrapper.startsWith(compact)
      : compact.startsWith(wrapper) && body.startsWith(compact.slice(wrapper.length)));
}

/**
 * Index where leaked tool-call markup starts in `content`, or -1.
 *
 * With `streaming`, a trailing fragment that could still grow into markup also
 * counts, so the caller holds it back until a later update decides it.
 */
export function toolCallMarkupStart(content: string, options: { streaming?: boolean } = {}): number {
  if (!content.includes("<")) return -1;
  let offset = 0;
  let fenced = false;
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1;
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.trim()) continue;
    const sentinel = SENTINEL_PATTERN.exec(line);
    if (sentinel) return lineStart + sentinel.index;
    const indent = line.length - line.trimStart().length;
    // Bound the look-ahead: a wrapper and the start of its call body fit well
    // within it, and the bound keeps each scan linear in the text length.
    const rest = line[indent] === "<" ? content.slice(lineStart + indent, lineStart + indent + 256) : "";
    if (rest && LINE_FORMS.some(({ pattern }) => pattern.test(rest))) return lineStart + indent;
    if (!options.streaming) continue;
    // A wrapper and its body can span lines, so a line that holds only an
    // opening wrapper is undecided until the following non-blank line arrives.
    if (rest && couldBecomeLineForm(rest)) return lineStart + indent;
    if (index === lines.length - 1) {
      const lastOpen = line.lastIndexOf("<");
      if (lastOpen >= 0 && line.length - lastOpen < LONGEST_SENTINEL_OPENING
        && SENTINEL_OPENINGS.some(opening => opening.startsWith(line.slice(lastOpen))))
        return lineStart + lastOpen;
    }
  }
  return -1;
}

/** Whether completed assistant text contains a leaked, unexecuted tool call. */
export function containsToolCallMarkup(content: string): boolean {
  return toolCallMarkupStart(content) >= 0;
}

/** The prefix of streaming assistant text that is safe to show as progress. */
export function visibleBeforeToolCallMarkup(content: string): string {
  const start = toolCallMarkupStart(content, { streaming: true });
  return start < 0 ? content : content.slice(0, start);
}
