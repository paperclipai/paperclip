import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createUpstreamServedTap, type UpstreamServed } from "./upstream-served.js";

async function run(chunks: Array<string | Buffer>, headers: { contentType?: string; contentEncoding?: string },
  onServed?: (served: UpstreamServed) => void) {
  const served: UpstreamServed[] = [];
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
    createUpstreamServedTap({ contentType: headers.contentType, contentEncoding: headers.contentEncoding,
      onServed: onServed ?? (value => served.push(value)) }),
    new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }),
  );
  return { served, output: Buffer.concat(output) };
}

const sse = [
  ": OPENROUTER PROCESSING\n\n",
  'data: {"id":"gen-1762981234-AbCdEfGh","provider":"Novita","model":"deepseek/deepseek-v4.1-flash","choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"id":"gen-1762981234-AbCdEfGh","provider":"Novita","choices":[{"delta":{"content":"lo"}}]}\n\n',
  "data: [DONE]\n\n",
];

describe("createUpstreamServedTap", () => {
  it("records the serving host from the first streamed chunk and forwards every byte unchanged", async () => {
    const result = await run(sse, { contentType: "text/event-stream; charset=utf-8" });
    expect(result.output.toString("utf8")).toBe(sse.join(""));
    expect(result.served).toEqual([{ upstreamProvider: "Novita", providerRequestId: "gen-1762981234-AbCdEfGh" }]);
  });

  it("finds the host when an event is split across chunks and multibyte text straddles the split", async () => {
    const whole = Buffer.from('data: {"id":"gen-2","provider":"Chutes","choices":[{"delta":{"content":"héllo"}}]}\r\n\r\n');
    const split = whole.indexOf(Buffer.from("é")) + 1;
    const result = await run([whole.subarray(0, 10), whole.subarray(10, split), whole.subarray(split)], { contentType: "text/event-stream" });
    expect(Buffer.compare(result.output, whole)).toBe(0);
    expect(result.served).toEqual([{ upstreamProvider: "Chutes", providerRequestId: "gen-2" }]);
  });

  it("records the host of a non-streamed completion", async () => {
    const body = JSON.stringify({ id: "gen-3", provider: "DeepInfra", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    const result = await run([body.slice(0, 7), body.slice(7)], { contentType: "application/json" });
    expect(result.output.toString("utf8")).toBe(body);
    expect(result.served).toEqual([{ upstreamProvider: "DeepInfra", providerRequestId: "gen-3" }]);
  });

  it("skips recording a malformed chunk without changing the response", async () => {
    const chunks = ["data: {not json\n\n", "data: {\"id\":7,\"provider\":\"\"}\n\n", "data: [DONE]\n\n"];
    const result = await run(chunks, { contentType: "text/event-stream" });
    expect(result.output.toString("utf8")).toBe(chunks.join(""));
    expect(result.served).toEqual([]);
    const json = await run(['{"provider":"Novita",'], { contentType: "application/json" });
    expect(json.output.toString("utf8")).toBe('{"provider":"Novita",');
    expect(json.served).toEqual([]);
  });

  it("records a host without a usable generation id", async () => {
    const result = await run(['data: {"provider":"Novita","id":42}\n\n'], { contentType: "text/event-stream" });
    expect(result.served).toEqual([{ upstreamProvider: "Novita", providerRequestId: null }]);
  });

  it("leaves encoded and unknown bodies alone", async () => {
    expect((await run(sse, { contentType: "text/event-stream", contentEncoding: "gzip" })).served).toEqual([]);
    expect((await run(sse, { contentType: "text/plain" })).served).toEqual([]);
  });

  it("stops scanning a stream that names no host within its first 64 KiB", async () => {
    const filler = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(70 * 1024) } }] })}\n\n`;
    const result = await run([filler, 'data: {"id":"gen-4","provider":"Late"}\n\n'], { contentType: "text/event-stream" });
    expect(result.output.toString("utf8")).toBe(`${filler}data: {"id":"gen-4","provider":"Late"}\n\n`);
    expect(result.served).toEqual([]);
  });

  it("keeps the response flowing when the recorder throws", async () => {
    const result = await run(sse, { contentType: "text/event-stream" }, () => { throw new Error("recorder failed"); });
    expect(result.output.toString("utf8")).toBe(sse.join(""));
  });
});
