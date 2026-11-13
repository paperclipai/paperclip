import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createJsonlLineReader } from "./jsonl-line-reader.js";

function collect(input = new PassThrough()) {
  const lines: string[] = [];
  const reader = createJsonlLineReader({ input });
  reader.on("line", line => lines.push(line));
  return { input, reader, lines };
}

describe("strict JSONL framing", () => {
  it("preserves Unicode separators and split UTF-8 code points", async () => {
    const { input, reader, lines } = collect();
    const value = { text: "中文\u2028第一段\u2029😀\n最后一行" };
    const closed = once(reader, "close");
    for (const byte of Buffer.from(`${JSON.stringify(value)}\n`)) {
      input.write(Buffer.from([byte]));
    }
    input.end();
    await closed;
    expect(lines.map(line => JSON.parse(line))).toEqual([value]);
  });

  it("accepts LF, split CRLF, empty records, and an unterminated EOF record", async () => {
    const { input, reader, lines } = collect();
    const closed = once(reader, "close");
    input.write('1\r');
    input.write('\n\n2\n');
    input.end('3');
    await closed;
    expect(lines).toEqual(["1", "", "2", "3"]);
  });

  it("does not treat a bare CR or Unicode separator as a record boundary", async () => {
    const { input, reader, lines } = collect();
    const closed = once(reader, "close");
    input.end('1\r2\u20283\u20294\n');
    await closed;
    expect(lines).toEqual(['1\r2\u20283\u20294']);
  });

  it("handles streams that already decode UTF-8", async () => {
    const input = new PassThrough();
    input.setEncoding("utf8");
    const { reader, lines } = collect(input);
    const closed = once(reader, "close");
    input.end('"中文\u2028\u2029"\n');
    await closed;
    expect(lines.map(line => JSON.parse(line))).toEqual(["中文\u2028\u2029"]);
  });

  it("closes once and detaches without emitting buffered or subsequent records", () => {
    const { input, reader, lines } = collect();
    const closed = vi.fn();
    reader.on("close", closed);
    reader.on("line", () => reader.close());
    input.write('1\n2\npartial');
    reader.close();
    input.end('3\n');
    expect(lines).toEqual(["1"]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("pauses input while the owner drains pending work", () => {
    const { input, reader, lines } = collect();
    reader.pause();
    input.write('1\n');
    expect(input.isPaused()).toBe(true);
    expect(lines).toEqual([]);
    reader.close();
    input.destroy();
  });
});
