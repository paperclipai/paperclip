import { describe, expect, it } from "vitest";

import { canonicalProviderEventsFromOpenCodePart } from "../../provider-events.js";
import {
  OPENCODE_SSE_LIMITS,
  annotateOmittedProviderText,
  parseOpenCodeSseFrames,
  type OpenCodeSseFrame,
} from "./sse-frames.js";

function stream(text: string, chunkChars = 64 * 1024): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkChars)
        controller.enqueue(bytes.subarray(index, index + chunkChars));
      controller.close();
    },
  });
}

async function frames(text: string, chunkChars?: number): Promise<OpenCodeSseFrame[]> {
  const collected: OpenCodeSseFrame[] = [];
  for await (const frame of parseOpenCodeSseFrames(stream(text, chunkChars)))
    collected.push(frame);
  return collected;
}

function sse(value: unknown, newline = "\n"): string {
  return `data: ${JSON.stringify(value)}${newline}${newline}`;
}

function completedToolPart(output: string) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_tool",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "pnpm test", description: "Run tests" },
          output,
          title: "Run tests",
          metadata: { exit: 1, output, description: "Run tests" },
          time: { start: 1, end: 2 },
        },
      },
    },
  };
}

describe("parseOpenCodeSseFrames", () => {
  it("keeps frames below the limit exact even when one chunk holds more than the limit", async () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      type: "message.part.updated",
      properties: { index, text: "x".repeat(32 * 1024) },
    }));
    const text = events.map((event) => sse(event)).join("");
    expect(text.length).toBeGreaterThan(OPENCODE_SSE_LIMITS.frameChars);
    const parsed = await frames(text, text.length);
    expect(parsed).toHaveLength(40);
    expect(parsed.every((frame) => frame.compaction === undefined)).toBe(true);
    expect(parsed.map((frame) => JSON.parse(frame.data))).toEqual(events);
  });

  it("bounds a complete oversized event inside one chunk without changing its neighbors", async () => {
    const before = { type: "server.connected", properties: {} };
    const after = { type: "session.idle", properties: { sessionID: "ses_1" } };
    const output = "begin\n" + "x".repeat(1_200_000) + "\nexit status 1";
    const text = sse(before) + sse(completedToolPart(output)) + sse(after);
    const parsed = await frames(text, text.length);
    expect(parsed).toHaveLength(3);
    expect(JSON.parse(parsed[0]!.data)).toEqual(before);
    expect(parsed[0]!.compaction).toBeUndefined();
    expect(parsed[1]!.compaction).toMatchObject({ omitted: false, truncatedStrings: 2 });
    expect(parsed[1]!.data.length).toBeLessThan(OPENCODE_SSE_LIMITS.frameChars);
    const event = JSON.parse(parsed[1]!.data);
    annotateOmittedProviderText(event, parsed[1]!.compaction!);
    const [canonical] = canonicalProviderEventsFromOpenCodePart(event.properties.part);
    expect(canonical?.payload).toMatchObject({
      status: "completed", outputBytes: Buffer.byteLength(output), outputTruncated: true, outputDigest: null,
    });
    expect(String(canonical?.payload.output).endsWith("exit status 1")).toBe(true);
    expect(JSON.parse(parsed[2]!.data)).toEqual(after);
    expect(parsed[2]!.compaction).toBeUndefined();
  });

  it("compacts an oversized tool event and keeps its outcome and the next event", async () => {
    const head = "PASS early suite\n";
    const tail = "\nFAIL src/last.test.ts\nTests: 1 failed, 812 passed\nexit status 1";
    const output = head + "é ✓ \"quoted\" \\ 🙂 line\n".repeat(80_000) + tail;
    const next = { type: "session.idle", properties: { sessionID: "ses_1" } };
    const parsed = await frames(sse(completedToolPart(output), "\r\n") + sse(next), 4093);

    expect(parsed).toHaveLength(2);
    const [oversized, following] = parsed;
    expect(oversized!.compaction).toMatchObject({
      omitted: false,
      eventType: "message.part.updated",
      truncatedStrings: 2,
    });
    expect(oversized!.compaction!.frameChars).toBeGreaterThan(2 * output.length);
    expect(oversized!.data.length).toBeLessThan(OPENCODE_SSE_LIMITS.frameChars);
    expect(oversized!.compaction!.truncations).toEqual([
      expect.objectContaining({
        path: ["properties", "part", "state", "output"],
        chars: output.length,
        bytes: Buffer.byteLength(output),
      }),
      expect.objectContaining({
        path: ["properties", "part", "state", "metadata", "output"],
        chars: output.length,
        bytes: Buffer.byteLength(output),
      }),
    ]);

    const event = JSON.parse(oversized!.data);
    const part = event.properties.part;
    expect(part).toMatchObject({
      id: "prt_tool",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pnpm test", description: "Run tests" },
        title: "Run tests",
        metadata: { exit: 1, description: "Run tests" },
        time: { start: 1, end: 2 },
      },
    });
    expect(part.state.output.startsWith(head)).toBe(true);
    expect(part.state.output.endsWith(tail)).toBe(true);
    expect(part.state.output).toMatch(/…\[\d+ characters omitted\]…/);
    expect(JSON.parse(following!.data)).toEqual(next);
    expect(following!.compaction).toBeUndefined();

    annotateOmittedProviderText(event, oversized!.compaction!);
    const [canonical] = canonicalProviderEventsFromOpenCodePart(part);
    expect(canonical).toMatchObject({
      eventType: "tool.execution.completed",
      payload: {
        name: "bash",
        status: "completed",
        outputBytes: Buffer.byteLength(output),
        outputTruncated: true,
        outputDigest: null,
      },
    });
    expect(String(canonical!.payload.output).endsWith(tail)).toBe(true);
    expect(String(canonical!.payload.output).length).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(part)).not.toContain("omittedProviderText");
  });

  it("counts unpaired surrogate output as the original UTF-8 text", async () => {
    const output = "\ud800" + "x".repeat(1_200_000) + "\udc00";
    const [frame] = await frames(sse(completedToolPart(output)), 4093);
    expect(frame!.compaction!.truncations).toEqual([
      expect.objectContaining({ bytes: Buffer.byteLength(output) }),
      expect.objectContaining({ bytes: Buffer.byteLength(output) }),
    ]);
  });

  it.each([[12, 64 * 1024], [80, 100_000]])("prioritizes output after %i large input values", async (count, inputChars) => {
    const output = "o".repeat(300_000) + "\nfinal error: command failed\nexit status 1";
    const event = completedToolPart(output);
    Object.assign(event.properties.part.state.input, {
      values: Array.from({ length: count }, () => "i".repeat(inputChars)),
    });
    const [frame] = await frames(sse(event));
    const compacted = JSON.parse(frame!.data);
    annotateOmittedProviderText(compacted, frame!.compaction!);
    const [canonical] = canonicalProviderEventsFromOpenCodePart(compacted.properties.part);
    expect(canonical?.payload).toMatchObject({
      outputBytes: Buffer.byteLength(output), outputTruncated: true, outputDigest: null,
    });
    expect(String(canonical?.payload.output).endsWith("final error: command failed\nexit status 1")).toBe(true);
    expect(frame!.compaction!.truncations.length).toBeLessThanOrEqual(OPENCODE_SSE_LIMITS.truncations);
  });

  it.each([["\n", 1], ["\r\n", 1], ["\r\n", 2], ["\r\n", 3]] as const)(
    "keeps an exact-limit frame with separator %j split after %i bytes", async (newline, split) => {
      const empty = `data: ${JSON.stringify({ type: "message.part.updated", properties: { text: "" } })}`;
      const event = { type: "message.part.updated", properties: { text: "x".repeat(OPENCODE_SSE_LIMITS.frameChars - empty.length) } };
      const raw = `data: ${JSON.stringify(event)}`;
      expect(raw.length).toBe(OPENCODE_SSE_LIMITS.frameChars);
      const [frame] = await frames(raw + newline + newline, raw.length + split);
      expect(frame!.compaction).toBeUndefined();
      expect(JSON.parse(frame!.data)).toEqual(event);
    },
  );

  it("does not report a separator blank line before an oversized frame", async () => {
    const small = { type: "server.connected", properties: {} };
    const large = completedToolPart("y".repeat(1_200_000));
    const parsed = await frames(`${sse(small)}\n${sse(large)}`, 1_100_000);
    expect(parsed.map((frame) => frame.compaction?.omitted ?? null)).toEqual([null, false]);
    expect(JSON.parse(parsed[1]!.data).properties.part.state.status).toBe("completed");
  });

  it("reports a frame whose compacted structure still exceeds the bound", async () => {
    const value = {
      type: "session.diff",
      properties: { files: Array.from({ length: 500_000 }, (_, index) => index) },
    };
    const next = { type: "session.idle", properties: {} };
    const parsed = await frames(sse(value) + sse(next));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      data: "",
      raw: "",
      compaction: { omitted: true, eventType: "session.diff" },
    });
    expect(JSON.parse(parsed[1]!.data)).toEqual(next);
  });

  it("keeps short identity strings once the long-string budget is spent", async () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      file: `src/file-${index}.ts`,
      before: "b".repeat(100_000),
      after: "a".repeat(100_000),
      status: "modified",
    }));
    const [frame] = await frames(sse({ type: "session.diff", properties: { files } }));
    const event = JSON.parse(frame!.data);
    expect(event.properties.files).toHaveLength(20);
    expect(event.properties.files.map((file: { file: string }) => file.file)).toEqual(
      files.map((file) => file.file),
    );
    expect(event.properties.files.every((file: { status: string }) => file.status === "modified")).toBe(true);
    expect(frame!.data.length).toBeLessThan(OPENCODE_SSE_LIMITS.frameChars);
  });
});
