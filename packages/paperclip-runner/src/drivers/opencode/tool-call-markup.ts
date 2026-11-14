const SENTINEL_FORMS = ["｜", "|"].flatMap(bar => [
  `<${bar}DSML${bar}`,
  ...["tool▁calls▁begin", "tool_calls_begin", "tool▁call▁begin", "tool_call_begin"].map(name => `<${bar}${name}${bar}>`),
]);

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

function firstSentinel(line: string): number {
  let first = -1;
  for (const form of SENTINEL_FORMS) {
    const index = line.indexOf(form);
    if (index >= 0 && (first < 0 || index < first)) first = index;
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
    const sentinel = firstSentinel(line);
    if (sentinel >= 0) return lineStart + sentinel;
    const indent = line.length - line.trimStart().length;
    const rest = line[indent] === "<" ? content.slice(lineStart + indent, lineStart + indent + LOOK_AHEAD) : "";
    if (rest && LINE_FORMS.some(({ pattern }) => pattern.test(rest))) return lineStart + indent;
    if (!options.streaming) continue;
    if (rest && couldBecomeLineForm(rest)) return lineStart + indent;
    if (index === lines.length - 1) {
      const lastOpen = line.lastIndexOf("<");
      if (lastOpen >= 0 && SENTINEL_FORMS.some(form => form.startsWith(line.slice(lastOpen)))) return lineStart + lastOpen;
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
