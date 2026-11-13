import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type UpstreamServed = { upstreamProvider: string; providerRequestId: string | null };

const STREAM_SCAN_LIMIT = 64 * 1024;
const JSON_SCAN_LIMIT = 1024 * 1024;
const FIELD_LIMIT = 240;

function servedFrom(value: unknown): UpstreamServed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { provider, id } = value as Record<string, unknown>;
  if (typeof provider !== "string" || !provider.trim() || provider.length > FIELD_LIMIT) return null;
  return {
    upstreamProvider: provider.trim(),
    providerRequestId: typeof id === "string" && id.trim() && id.length <= FIELD_LIMIT ? id.trim() : null,
  };
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function createUpstreamServedTap(input: {
  contentType: string | undefined;
  contentEncoding: string | undefined;
  onServed: (served: UpstreamServed) => void;
}): Transform {
  const mode = input.contentEncoding && input.contentEncoding !== "identity" ? null
    : /^text\/event-stream\b/i.test(input.contentType ?? "") ? "stream"
      : /^application\/json\b/i.test(input.contentType ?? "") ? "json" : null;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let scanned = 0;
  let done = mode === null;
  const stop = () => { done = true; pending = ""; };
  const report = (served: UpstreamServed | null) => {
    if (!served) return;
    stop();
    try { input.onServed(served); } catch { /* Recording never affects the response. */ }
  };
  const inspect = (chunk: Buffer, end: boolean) => {
    scanned += chunk.length;
    pending += end ? decoder.end() : decoder.write(chunk);
    if (mode === "json") {
      if (scanned > JSON_SCAN_LIMIT) stop();
      else if (end) report(servedFrom(parse(pending)));
      return;
    }
    let newline = pending.indexOf("\n");
    while (!done && newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") report(servedFrom(parse(data)));
      }
      newline = pending.indexOf("\n");
    }
    if (!done && scanned > STREAM_SCAN_LIMIT) stop();
  };
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      this.push(chunk);
      if (!done) {
        try { inspect(chunk, false); } catch { stop(); }
      }
      callback();
    },
    flush(callback: TransformCallback) {
      if (!done) {
        try { inspect(Buffer.alloc(0), true); } catch { /* Skip recording. */ }
      }
      stop();
      callback();
    },
  });
}
