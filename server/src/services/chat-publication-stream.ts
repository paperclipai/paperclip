const DEFAULT_CHUNK_CODE_POINTS = 280;
const DEFAULT_CHUNK_DELAY_MS = 75;

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
