import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export function createJsonlLineReader({ input }: { input: NodeJS.ReadableStream }) {
  const reader = new EventEmitter<{
    line: [line: string];
    close: [];
  }>();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let closed = false;

  function emitLine(line: string): void {
    reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  function onData(chunk: string | Buffer): void {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (!closed) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      emitLine(line);
    }
  }

  function onEnd(): void {
    buffer += decoder.end();
    if (buffer.length > 0) emitLine(buffer);
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
    buffer = "";
    reader.emit("close");
  }

  input.on("data", onData);
  input.on("end", onEnd);
  return Object.assign(reader, { close, pause: () => { input.pause(); } });
}

export type JsonlLineReader = ReturnType<typeof createJsonlLineReader>;
