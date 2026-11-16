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

/**
 * Inline code spans as [start, end) offsets: a backtick run closes at the next
 * run of the same length within its paragraph. An escaped backtick opens
 * nothing, an unmatched run is literal text, and backticks inside fenced
 * blocks never pair with ones outside.
 */
function codeSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!source.includes("`")) return spans;
  const content = withoutFencedBlocks(source);
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "`") continue;
    let length = 1;
    while (content[index + length] === "`") length += 1;
    const paragraphEnd = content.indexOf("\n\n", index);
    const limit = paragraphEnd < 0 ? content.length : paragraphEnd;
    let close = -1;
    for (let at = index + length; at < limit; at += 1) {
      if (content[at] !== "`") continue;
      let run = 1;
      while (content[at + run] === "`") run += 1;
      if (run === length) {
        close = at;
        break;
      }
      at += run - 1;
    }
    if (close < 0) {
      index += length - 1;
      continue;
    }
    spans.push([index, close + length]);
    index = close + length - 1;
  }
  return spans;
}

/** First sentinel on the line that is not inside an inline code span. */
function firstSentinel(line: string, lineStart: number, spans: Array<[number, number]>, forms: readonly string[]): number {
  // Every sentinel starts with `<|`, `<｜`, `</|` or `</｜`.
  if (!SENTINEL_OPENING.test(line)) return -1;
  const inCode = (offset: number) => spans.some(([start, end]) => offset >= start && offset < end);
  let first = -1;
  for (const form of forms) {
    for (let index = line.indexOf(form); index >= 0 && (first < 0 || index < first); index = line.indexOf(form, index + 1)) {
      if (!inCode(lineStart + index)) {
        first = index;
        break;
      }
    }
  }
  return first;
}

/** The content with every fenced block's lines blanked, keeping offsets. */
function withoutFencedBlocks(content: string): string {
  let openFence: { indent: number; char: string; length: number } | null = null;
  return content.split("\n").map(line => {
    const fence = fenceOf(line);
    if (openFence) {
      if (closesFence(fence, openFence)) openFence = null;
      return " ".repeat(line.length);
    }
    if (opensFence(fence)) {
      openFence = { indent: fence.indent, char: fence.char, length: fence.length };
      return " ".repeat(line.length);
    }
    return line;
  }).join("\n");
}

type Fence = { indent: number; char: string; length: number; rest: string };

function closesFence(fence: Fence | null, open: { indent: number; char: string; length: number }): boolean {
  return !!fence && fence.indent <= open.indent + 3 && fence.char === open.char && fence.length >= open.length && !fence.rest.trim();
}

function opensFence(fence: Fence | null): fence is Fence {
  return !!fence && !(fence.char === "`" && fence.rest.includes("`"));
}

function fenceOf(line: string): Fence | null {
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
  const spans = codeSpans(content);
  let offset = 0;
  let openFence: { indent: number; char: string; length: number } | null = null;
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1;
    const fence = fenceOf(line);
    if (openFence) {
      if (closesFence(fence, openFence)) openFence = null;
      continue;
    }
    if (opensFence(fence)) {
      openFence = { indent: fence.indent, char: fence.char, length: fence.length };
      continue;
    }
    if (!line.trim()) continue;
    const sentinel = firstSentinel(line, lineStart, spans, forms);
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
