import { describe, expect, it } from "vitest";
import { ollamaNdjsonLines, parseOllamaChatStream } from "./parse.js";

function stream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = chunks.map((c) =>
    typeof c === "string" ? new TextEncoder().encode(c) : c,
  );
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(queue[i]!);
      i += 1;
    },
  });
}

describe("ollamaNdjsonLines", () => {
  it("yields one line per newline-terminated record", async () => {
    const out: string[] = [];
    for await (const line of ollamaNdjsonLines(stream(["a\n", "b\n", "c\n"]))) out.push(line);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("joins partial JSON split across chunks", async () => {
    const out: string[] = [];
    for await (const line of ollamaNdjsonLines(stream(['{"x":', "1}", "\n"]))) out.push(line);
    expect(out).toEqual(['{"x":1}']);
  });

  it("skips blank lines between frames", async () => {
    const out: string[] = [];
    for await (const line of ollamaNdjsonLines(stream(["one\n\n", "\n", "two\n"]))) out.push(line);
    expect(out).toEqual(["one", "two"]);
  });

  it("preserves multi-byte UTF-8 sequences split across chunk boundaries", async () => {
    const full = new TextEncoder().encode("é汉字\n");
    const split = [full.slice(0, 1), full.slice(1, 4), full.slice(4)];
    const out: string[] = [];
    for await (const line of ollamaNdjsonLines(stream(split))) out.push(line);
    expect(out).toEqual(["é汉字"]);
  });

  it("stops early when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const out: string[] = [];
    for await (const line of ollamaNdjsonLines(stream(["a\n", "b\n"]), controller.signal)) out.push(line);
    expect(out.length).toBeLessThanOrEqual(1);
  });
});

describe("parseOllamaChatStream", () => {
  it("accumulates assistant content and emits per-frame onDelta pieces in order", async () => {
    const seen: string[] = [];
    const frames = [
      { message: { role: "assistant", content: "Hello " }, done: false },
      { message: { role: "assistant", content: "world" }, done: false },
      {
        message: { role: "assistant", content: "!" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 12,
        eval_count: 4,
      },
    ];
    const parsed = await parseOllamaChatStream(
      stream(frames.map((f) => `${JSON.stringify(f)}\n`)),
      {
        onDelta: (piece) => {
          seen.push(piece);
        },
      },
    );
    expect(seen).toEqual(["Hello ", "world", "!"]);
    expect(parsed.assistantText).toBe("Hello world!");
    expect(parsed.finalFrame?.done_reason).toBe("stop");
    expect(parsed.frameCount).toBe(3);
    expect(parsed.parseErrorCount).toBe(0);
    expect(parsed.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it("counts malformed NDJSON lines but keeps parsing", async () => {
    const payload = [
      '{"message":{"content":"ok"},"done":false}',
      "not-json",
      '{"message":{"content":"!"},"done":true,"done_reason":"stop"}',
    ]
      .map((l) => `${l}\n`)
      .join("");
    const parsed = await parseOllamaChatStream(stream([payload]));
    expect(parsed.assistantText).toBe("ok!");
    expect(parsed.parseErrorCount).toBe(1);
    expect(parsed.finalFrame?.done_reason).toBe("stop");
  });

  it("flags context truncation when prompt_eval_count >= contextWindow", async () => {
    const frames = [
      { message: { role: "assistant", content: "short reply" }, done: false },
      {
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 8192,
        eval_count: 3,
      },
    ];
    const parsed = await parseOllamaChatStream(
      stream(frames.map((f) => `${JSON.stringify(f)}\n`)),
      { contextWindow: 8192 },
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.usage?.inputTokens).toBe(8192);
  });

  it("does not flag truncation when prompt_eval_count < contextWindow", async () => {
    const frames = [
      { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 100, eval_count: 5 },
    ];
    const parsed = await parseOllamaChatStream(
      stream(frames.map((f) => `${JSON.stringify(f)}\n`)),
      { contextWindow: 8192 },
    );
    expect(parsed.truncated).toBe(false);
  });
});
