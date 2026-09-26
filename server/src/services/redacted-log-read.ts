import { redactTransportCredentials } from "@paperclipai/adapter-utils/command-redaction";

/**
 * Bytes of log read on either side of a client range before redaction.
 * A client can otherwise ask for a slice that ends before `@` and receive
 * the userinfo of `https://<token>@host` unchanged.
 */
const REDACTION_MARGIN_BYTES = 16_384;
/** Cap for one physical line when the first window does not contain its end. */
const MAX_LINE_BYTES = 64 * 1024;

export type LogRangeRead = (opts: {
  offset: number;
  limitBytes: number;
}) => Promise<{ content: string; nextOffset?: number }>;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function charIndexAtByte(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    const step = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    const size = byteLength(text.slice(index, index + step));
    if (bytes + size > byteOffset) return index;
    bytes += size;
    index += step;
  }
  return text.length;
}

/**
 * Read a log range and redact transport credentials on whole lines.
 *
 * `nextOffset` stays on the original byte stream so tailers keep their place.
 * The returned text may start at the beginning of the line that contains
 * `offset`, which is what makes a mid-token range unable to skip the
 * `https://` or `@` anchors.
 */
export async function readRedactedLogContent(
  read: LogRangeRead,
  opts?: { offset?: number; limitBytes?: number },
): Promise<{ content: string; nextOffset?: number }> {
  const requestStart = Math.max(0, Math.trunc(opts?.offset ?? 0));
  const limitBytes = Math.max(1, Math.trunc(opts?.limitBytes ?? 256_000));
  const back = Math.min(requestStart, REDACTION_MARGIN_BYTES);
  const windowStart = requestStart - back;
  const window = await read({
    offset: windowStart,
    limitBytes: back + limitBytes + REDACTION_MARGIN_BYTES,
  });
  const text = window.content ?? "";
  if (text.length === 0) return { content: "", nextOffset: window.nextOffset };

  const eof = window.nextOffset == null;
  const startChar = charIndexAtByte(text, requestStart - windowStart);
  let from = startChar;
  while (from > 0 && text.charCodeAt(from - 1) !== 10) from -= 1;

  const requestEndByte = requestStart + limitBytes;
  const windowEndByte = windowStart + byteLength(text);
  let to = charIndexAtByte(
    text,
    Math.max(0, Math.min(requestEndByte, windowEndByte) - windowStart),
  );
  if (to < from) to = from;
  if (to < text.length && (to === 0 || text.charCodeAt(to - 1) !== 10)) {
    const closer = text.indexOf("\n", to);
    if (closer !== -1) to = closer + 1;
  }

  const closed = to > from && text.charCodeAt(to - 1) === 10;
  const atEof = eof && to >= text.length;
  if (closed || atEof) {
    const contentStart = windowStart + byteLength(text.slice(0, from));
    const contentEnd = windowStart + byteLength(text.slice(0, to));
    const content = redactTransportCredentials(text.slice(from, to));
    return {
      content,
      // Tailers that see no nextOffset do `offset + content.length`. A slice
      // that starts before the request, or a redaction that changes length,
      // would then skip bytes appended after this read.
      nextOffset: resumeOffset({
        atEof,
        requestStart,
        contentStart,
        contentEnd,
        redactedBytes: byteLength(content),
      }),
    };
  }

  // The line continues past the margin. Read it from its start, then redact
  // that whole line. Advance even when it exceeds the caller's limit so a
  // short range cannot stall on the same secret.
  const openRelative = text.slice(from).lastIndexOf("\n");
  const completePrefix = openRelative === -1 ? "" : text.slice(from, from + openRelative + 1);
  const openChar = from + (openRelative === -1 ? 0 : openRelative + 1);
  const openByte = windowStart + byteLength(text.slice(0, openChar));
  const extended = await read({ offset: openByte, limitBytes: MAX_LINE_BYTES });
  const extendedText = extended.content ?? "";
  const newline = extendedText.indexOf("\n");
  const openLine = newline === -1 ? extendedText : extendedText.slice(0, newline + 1);
  const content = redactTransportCredentials(`${completePrefix}${openLine}`);
  const consumed = openByte + byteLength(openLine);
  const extendedEof = extended.nextOffset == null && (newline === -1 || newline + 1 >= extendedText.length);
  const contentStart = windowStart + byteLength(text.slice(0, from));
  return {
    content,
    nextOffset: resumeOffset({
      atEof: extendedEof,
      requestStart,
      contentStart,
      contentEnd: consumed,
      redactedBytes: byteLength(content),
    }),
  };
}

/**
 * Byte on the original stream where the next read should start.
 *
 * `undefined` means the caller is caught up: the returned text is exactly the
 * unread suffix, so `offset + content.length` lands on EOF. Any other shape
 * must return the real end byte. Otherwise a poller counts the rewound line
 * prefix as new data and the next poll starts past output that arrived later.
 */
function resumeOffset(opts: {
  atEof: boolean;
  requestStart: number;
  contentStart: number;
  contentEnd: number;
  redactedBytes: number;
}): number | undefined {
  if (!opts.atEof) return opts.contentEnd;
  const startsAtRequest = opts.contentStart === opts.requestStart;
  const lengthMatches = opts.redactedBytes === opts.contentEnd - opts.requestStart;
  if (startsAtRequest && lengthMatches) return undefined;
  return opts.contentEnd;
}
