// DeepSeek writes a call as DSML tags. After a real tool call it can also
// trail only the closing tags (`</｜DSML｜ invoke>`), so both forms count.
const SENTINEL_FORMS = ["｜", "|"].flatMap(bar => [
  `<${bar}DSML${bar}`,
  `</${bar}DSML${bar}`,
  ...["tool▁calls▁begin", "tool_calls_begin", "tool▁call▁begin", "tool_call_begin"].map(name => `<${bar}${name}${bar}>`),
]);

// Tokenizer control tokens are never prose. A model that writes one has
// restarted a document or a turn (cohort 16 replied `<｜begin▁of▁sentence｜>`
// followed by an imitation tool-output fragment).
const CONTROL_TOKEN_FORMS = [
  ...["｜", "|"].flatMap(bar => ["begin▁of▁sentence", "end▁of▁sentence", "begin_of_sentence", "end_of_sentence", "User", "Assistant"].map(name => `<${bar}${name}${bar}>`)),
  ...["im_start", "im_end", "endoftext", "begin_of_text", "end_of_text", "eot_id", "start_header_id", "end_header_id"].map(name => `<|${name}|>`),
];

const LINE_FORMS = [
  { wrapper: "<function_calls>", body: '<invokename="', pattern: /^<function_calls>\s*<invoke\s+name\s*=/ },
  { wrapper: "<tool_call>", body: '{"name":', pattern: /^<tool_call>\s*\{\s*"name"\s*:/ },
];

const LOOK_AHEAD = 256;

function couldBecomeLineForm(rest: string): boolean {
  const compact = rest.replace(/\s+/g, "");
  if (!compact) return false;
  return LINE_FORMS.some(({ wrapper, body }) =>
    compact.length <= wrapper.length
      ? wrapper.startsWith(compact)
      : compact.startsWith(wrapper) && body.startsWith(compact.slice(wrapper.length)));
}

const SENTINEL_OPENING = /<\/?[|｜]/;

/** First sentinel on the line that is not inside an inline code span. */
function firstSentinel(line: string, forms: readonly string[]): number {
  // Every sentinel starts with `<|`, `<｜`, `</|` or `</｜`.
  if (!SENTINEL_OPENING.test(line)) return -1;
  let first = -1;
  for (const form of forms) {
    for (let index = line.indexOf(form); index >= 0 && (first < 0 || index < first); index = line.indexOf(form, index + 1)) {
      if ((line.slice(0, index).match(/`/g)?.length ?? 0) % 2 === 0) {
        first = index;
        break;
      }
    }
  }
  return first;
}

function fenceOf(line: string): { indent: number; char: string; length: number; rest: string } | null {
  const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  return match
    ? { indent: match[1]!.replace(/\t/g, "    ").length, char: match[2]![0]!, length: match[2]!.length, rest: match[3]! }
    : null;
}

export function toolCallMarkupStart(content: string, options: { streaming?: boolean } = {}): number {
  return scaffoldingStart(content, SENTINEL_FORMS, true, options.streaming === true);
}

/** Where the first model control token outside code starts, or -1. */
export function controlTokenStart(content: string, options: { streaming?: boolean } = {}): number {
  return scaffoldingStart(content, CONTROL_TOKEN_FORMS, false, options.streaming === true);
}

function scaffoldingStart(content: string, forms: readonly string[], lineForms: boolean, streaming: boolean): number {
  if (!content.includes("<")) return -1;
  let offset = 0;
  let openFence: { indent: number; char: string; length: number } | null = null;
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1;
    const fence = fenceOf(line);
    if (openFence) {
      if (fence && fence.indent <= openFence.indent + 3 && fence.char === openFence.char && fence.length >= openFence.length && !fence.rest.trim())
        openFence = null;
      continue;
    }
    if (fence && !(fence.char === "`" && fence.rest.includes("`"))) {
      openFence = { indent: fence.indent, char: fence.char, length: fence.length };
      continue;
    }
    if (!line.trim()) continue;
    const sentinel = firstSentinel(line, forms);
    if (sentinel >= 0) return lineStart + sentinel;
    if (lineForms) {
      const indent = line.length - line.trimStart().length;
      const rest = line[indent] === "<" ? content.slice(lineStart + indent, lineStart + indent + LOOK_AHEAD) : "";
      if (rest && LINE_FORMS.some(({ pattern }) => pattern.test(rest))) return lineStart + indent;
      if (streaming && rest && couldBecomeLineForm(rest)) return lineStart + indent;
    }
    if (streaming && index === lines.length - 1) {
      const lastOpen = line.lastIndexOf("<");
      if (lastOpen >= 0 && forms.some(form => form.startsWith(line.slice(lastOpen)))) return lineStart + lastOpen;
    }
  }
  return -1;
}

export function containsToolCallMarkup(content: string): boolean {
  return toolCallMarkupStart(content) >= 0;
}

export function visibleBeforeToolCallMarkup(content: string): string {
  const start = toolCallMarkupStart(content, { streaming: true });
  return start < 0 ? content : content.slice(0, start);
}

/**
 * The prose a person may see while a text part still streams: everything
 * before tool-call markup or a model control token, holding back a trailing
 * fragment that could still become either.
 */
export function visibleBeforeModelScaffolding(content: string): string {
  const starts = [toolCallMarkupStart(content, { streaming: true }), controlTokenStart(content, { streaming: true })].filter(start => start >= 0);
  return starts.length ? content.slice(0, Math.min(...starts)) : content;
}
