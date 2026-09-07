import { parseMarkdown } from "chat";

const DEFAULT_CHUNK_CODE_POINTS = 280;
const DEFAULT_CHUNK_DELAY_MS = 75;
export const TELEGRAM_DURABLE_PART_CODE_POINTS = 1_600;

const TELEGRAM_SPLIT_SAFE_MARKDOWN_NODES = new Set([
  "break",
  "paragraph",
  "root",
  "text",
]);

function splitByCodePoints(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let count = 0;
  for (const point of text) {
    current += point;
    count += 1;
    if (count >= size) {
      chunks.push(current);
      current = "";
      count = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function escapeSafeTelegramBoundary(
  points: string[],
  start: number,
  proposedEnd: number,
): number {
  let trailingBackslashes = 0;
  for (
    let index = proposedEnd - 1;
    index >= start && points[index] === "\\";
    index -= 1
  ) {
    trailingBackslashes += 1;
  }
  if (trailingBackslashes % 2 === 0) return proposedEnd;
  // Keep an escape prefix and the character it protects in the same provider
  // message. Moving one slash to the next part leaves an even trailing run in
  // the current part and never exceeds the hard limit.
  return proposedEnd - 1;
}

/**
 * Streams only an already-projected, externally publishable payload. Paperclip
 * never passes run logs, tool events, or model reasoning through this helper.
 * Adapters may use a native stream or their own bounded post/edit fallback.
 */
export async function* streamSafePublicationText(
  text: string,
  options: {
    chunkCodePoints?: number;
    delayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): AsyncIterable<string> {
  const chunkCodePoints = Math.max(
    1,
    Math.min(options.chunkCodePoints ?? DEFAULT_CHUNK_CODE_POINTS, 2_000),
  );
  const delayMs = Math.max(
    0,
    Math.min(options.delayMs ?? DEFAULT_CHUNK_DELAY_MS, 1_000),
  );
  const wait =
    options.wait ??
    (async (duration: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, duration));
    });
  const chunks = splitByCodePoints(text, chunkCodePoints);
  for (let index = 0; index < chunks.length; index += 1) {
    yield chunks[index];
    if (delayMs > 0 && index < chunks.length - 1) await wait(delayMs);
  }
}

export function shouldStreamSafePublicationText(text: string): boolean {
  return Array.from(text).length > DEFAULT_CHUNK_CODE_POINTS;
}

/**
 * Telegram regular messages accept at most 4,096 UTF-16 code units after
 * Markdown conversion. At 1,600 source code points, either astral expansion or
 * MarkdownV2 escaping remains below the provider ceiling. Joining the returned
 * parts reconstructs the exact safe publication text.
 */
export function splitTelegramPublicationText(text: string): string[] {
  const points = Array.from(text);
  if (points.length <= TELEGRAM_DURABLE_PART_CODE_POINTS) return [text];

  const parts: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    const hardEnd = Math.min(
      points.length,
      offset + TELEGRAM_DURABLE_PART_CODE_POINTS,
    );
    if (hardEnd === points.length) {
      parts.push(points.slice(offset).join(""));
      break;
    }

    // Long ordinary prose remains native Telegram text. Prefer paragraph,
    // line, then word boundaries without dropping their separators. A text
    // run with no usable boundary still falls back to the hard, code-point
    // safe ceiling.
    const minimumPreferredEnd =
      offset + Math.floor(TELEGRAM_DURABLE_PART_CODE_POINTS / 2);
    let end = hardEnd;
    for (const separator of ["\n\n", "\n", " ", "\t"] as const) {
      const separatorPoints = Array.from(separator);
      for (
        let candidate = hardEnd - separatorPoints.length;
        candidate >= minimumPreferredEnd;
        candidate -= 1
      ) {
        if (
          separatorPoints.every(
            (point, index) => points[candidate + index] === point,
          )
        ) {
          end = candidate + separatorPoints.length;
          break;
        }
      }
      if (end !== hardEnd) break;
    }
    const safeEnd = escapeSafeTelegramBoundary(points, offset, end);
    parts.push(points.slice(offset, safeEnd).join(""));
    offset = safeEnd;
  }
  return parts;
}

/**
 * Telegram parses every durable message part as a separate Markdown document.
 * Splitting a code fence, link, list, or other structured node changes its
 * meaning even when concatenating the source parts is byte-for-byte lossless.
 * Preserve those long responses as one native Markdown document attachment;
 * short Markdown and long unstructured prose remain inline.
 */
export function telegramMarkdownRequiresAttachment(text: string): boolean {
  if (Array.from(text).length <= TELEGRAM_DURABLE_PART_CODE_POINTS)
    return false;
  const isPlainMarkdownDocument = (document: string): boolean => {
    const root = parseMarkdown(document) as unknown;
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || typeof node !== "object") return false;
      const record = node as { children?: unknown; type?: unknown };
      if (
        typeof record.type !== "string" ||
        !TELEGRAM_SPLIT_SAFE_MARKDOWN_NODES.has(record.type)
      ) {
        return false;
      }
      if (record.children === undefined) continue;
      if (!Array.isArray(record.children)) return false;
      pending.push(...record.children);
    }
    return true;
  };
  try {
    if (!isPlainMarkdownDocument(text)) return true;
    // A fragment is a new Markdown document. Text such as "- item" can be
    // ordinary prose in the middle of the full paragraph but become a list if
    // a split makes it the start of the next Telegram message.
    return splitTelegramPublicationText(text).some(
      (part) => !isPlainMarkdownDocument(part),
    );
  } catch {
    // If provider-equivalent Markdown parsing cannot establish that every
    // split point is ordinary text, retain the full safe payload as a file.
    return true;
  }
}
