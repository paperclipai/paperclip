export type SseFrame = {
  id: string | null;
  event: string | null;
  data: string;
};

/** Parses a text/event-stream body into frames; comment-only blocks are skipped. */
export async function* parseSseStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let event: string | null = null;
  let data: string[] = [];
  let sawField = false;

  const flush = (): SseFrame | null => {
    const frame = sawField ? { id, event, data: data.join("\n") } : null;
    id = null;
    event = null;
    data = [];
    sawField = false;
    return frame;
  };

  const consume = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return flush();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      id = value;
      sawField = true;
    } else if (field === "event") {
      event = value;
      sawField = true;
    } else if (field === "data") {
      data.push(value);
      sawField = true;
    }
    return null;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const frame = consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame) yield frame;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const frame = consume(buffer);
    if (frame) yield frame;
  }
  const trailing = flush();
  if (trailing) yield trailing;
}
