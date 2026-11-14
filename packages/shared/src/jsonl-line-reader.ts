import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export function createJsonlLineReader({ input }: { input: NodeJS.ReadableStream }) {
  const reader = new EventEmitter<{
    line: [line: string];
    close: [];
  }>();
  const decoder = new StringDecoder("utf8");
  let fragments: string[] = [];
  let closed = false;

  function emitLine(line: string): void {
    reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  function onData(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    while (!closed) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex < 0) {
        if (start < text.length) fragments.push(text.slice(start));
        break;
      }
      fragments.push(text.slice(start, newlineIndex));
      const line = fragments.join("");
      fragments = [];
      start = newlineIndex + 1;
      emitLine(line);
    }
  }

  function onEnd(): void {
    const tail = decoder.end();
    if (tail) fragments.push(tail);
    if (fragments.length > 0) emitLine(fragments.join(""));
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
    fragments = [];
    reader.emit("close");
  }

  input.on("data", onData);
  input.on("end", onEnd);
  return Object.assign(reader, { close, pause: () => { input.pause(); } });
}

export type JsonlLineReader = ReturnType<typeof createJsonlLineReader>;
