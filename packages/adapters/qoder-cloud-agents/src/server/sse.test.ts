import { describe, expect, it } from "vitest";
import { parseSseStream, type SseFrame } from "./sse.js";

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const encoder = new TextEncoder();
  async function* body() {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(body())) frames.push(frame);
  return frames;
}

describe("parseSseStream", () => {
  it("parses id, event and data fields into frames", async () => {
    expect(await collect([
      'id: evt_1\nevent: agent.message\ndata: {"type":"agent.message"}\n\n',
      "event: heartbeat\ndata: {}\n\n",
    ])).toEqual([
      { id: "evt_1", event: "agent.message", data: '{"type":"agent.message"}' },
      { id: null, event: "heartbeat", data: "{}" },
    ]);
  });

  it("reassembles frames split across chunks, including inside a multi-byte character", async () => {
    const bytes = new TextEncoder().encode('id: evt_1\ndata: {"text":"你好"}\n\n');
    const split = bytes.length - 8;
    async function* body() {
      yield bytes.slice(0, 5);
      yield bytes.slice(5, split);
      yield bytes.slice(split);
    }
    const frames: SseFrame[] = [];
    for await (const frame of parseSseStream(body())) frames.push(frame);
    expect(frames).toEqual([{ id: "evt_1", event: null, data: '{"text":"你好"}' }]);
  });

  it("handles CRLF line endings, comments and multi-line data", async () => {
    expect(await collect([": keep-alive\r\n\r\nid: evt_2\r\ndata: line one\r\ndata: line two\r\n\r\n"])).toEqual([
      { id: "evt_2", event: null, data: "line one\nline two" },
    ]);
  });

  it("emits a final frame that is not terminated by a blank line", async () => {
    expect(await collect(["id: evt_3\ndata: tail"])).toEqual([{ id: "evt_3", event: null, data: "tail" }]);
  });
});
