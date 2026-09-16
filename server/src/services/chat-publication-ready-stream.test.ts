import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import { streamSafePublicationText } from "./chat-publication-stream.js";
import { classifyChatPublicationError } from "./chat-publication-errors.js";
import { nativePublicationTextFits } from "./chat-publication-text-parts.js";

// Local qualification only: load an independently copied candidate module,
// never a behavioral mock. CI/default runs use the installed pinned adapter.
vi.mock("@chat-adapter/slack", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_SLACK_STREAM_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});

const persistence = {
  async compareAndSet() {
    return true;
  },
  async deleteIfVersion() {
    return true;
  },
  async read() {
    return null;
  },
};
const source = "A complete, approved answer with useful details. ".repeat(60);

type NativeStreamCall = {
  chunks?: Array<{ type: string; text?: string }>;
  channel?: string;
  ts?: string;
};
type NativeStreamReceipt = {
  ok?: boolean;
  ts?: string;
  channel?: string;
  message?: { ts?: string };
};
const streamReceipt = {
  ok: true,
  ts: "1788.901",
  channel: "D-PAPERCLIP",
};

async function withNativeSlack(
  run: (harness: {
    stream(
      chunks: AsyncIterable<string | { type: string; text?: string }>,
    ): Promise<{ id: string }>;
    calls: Array<{ method: string; input: NativeStreamCall }>;
    start: ReturnType<
      typeof vi.fn<(input: NativeStreamCall) => Promise<NativeStreamReceipt>>
    >;
    append: ReturnType<
      typeof vi.fn<(input: NativeStreamCall) => Promise<NativeStreamReceipt>>
    >;
    stop: ReturnType<
      typeof vi.fn<(input: NativeStreamCall) => Promise<NativeStreamReceipt>>
    >;
    post: ReturnType<typeof vi.fn>;
    endTyping: ReturnType<typeof vi.fn<() => Promise<void>>>;
    useHttp(
      transport: (input: { method: string; body: URLSearchParams }) => Promise<{
        status: number;
        data: unknown;
        headers?: Record<string, string>;
      }>,
    ): void;
  }) => Promise<void>,
) {
  const runtime = createChatSdkEndpointRuntime({
    callbacks: { onMessage() {} },
    companyId: "bounded-slack-company",
    endpointId: "bounded-slack-endpoint",
    logger: "silent",
    persistence,
    providerConfig: {
      provider: "slack",
      userName: "paperclip-agent",
      credentials: {
        botToken: "xoxb-test",
        botUserId: "U-BOT",
        signingSecret: "test",
      },
    },
  });
  try {
    await runtime.initialize();
    const calls: Array<{ method: string; input: NativeStreamCall }> = [];
    const accept = (method: string) => async (input: NativeStreamCall) => {
      calls.push({ method, input });
      return streamReceipt;
    };
    const start = vi.fn<
      (input: NativeStreamCall) => Promise<NativeStreamReceipt>
    >(accept("start"));
    const append = vi.fn<
      (input: NativeStreamCall) => Promise<NativeStreamReceipt>
    >(accept("append"));
    const stop = vi.fn<
      (input: NativeStreamCall) => Promise<NativeStreamReceipt>
    >(accept("stop"));
    const post = vi.fn(async () => streamReceipt);
    const adapter = runtime.getProviderAdapter() as unknown as {
      _client: {
        chat: Record<string, unknown>;
        axios: { defaults: { adapter: unknown } };
        retryConfig: { retries: number };
        rejectRateLimitedCalls: boolean;
      };
      chat: { getState(): { getList(key: string): Promise<string[]> } };
      endTyping(threadId: string): Promise<void>;
      stream(
        threadId: string,
        chunks: AsyncIterable<string | { type: string; text?: string }>,
      ): Promise<{ id: string }>;
    };
    // These are the HTTP endpoints only. The real ChatStreamer retains and
    // combines its pending buffer, including the final stop payload.
    const originalEndpoints = { ...adapter._client.chat };
    Object.assign(adapter._client.chat, {
      startStream: start,
      appendStream: append,
      stopStream: stop,
      postMessage: post,
      update: post,
    });
    const endTyping = vi.fn<() => Promise<void>>(async () => undefined);
    adapter.endTyping = endTyping;
    vi.spyOn(adapter.chat.getState(), "getList").mockImplementation(
      async (key) => (key === "slack:user-by-name:x" ? ["U0123456789"] : []),
    );
    const useHttp = (
      transport: (input: { method: string; body: URLSearchParams }) => Promise<{
        status: number;
        data: unknown;
        headers?: Record<string, string>;
      }>,
    ) => {
      Object.assign(adapter._client.chat, originalEndpoints);
      expect(adapter._client.retryConfig.retries).toBe(0);
      expect(adapter._client.rejectRateLimitedCalls).toBe(true);
      adapter._client.axios.defaults.adapter = async (config: {
        url: string;
        data: string;
      }) => {
        const response = await transport({
          method: config.url.split("/").at(-1)!,
          body: new URLSearchParams(config.data),
        });
        return {
          ...response,
          data: structuredClone(response.data),
          config,
          request: { path: `/api/${config.url.split("/").at(-1)}` },
          statusText: "Synthetic test response",
          headers: response.headers ?? {},
        };
      };
    };
    await run({
      stream: (chunks) => adapter.stream("slack:D-PAPERCLIP:1788.400", chunks),
      calls,
      start,
      append,
      stop,
      post,
      endTyping,
      useHttp,
    });
  } finally {
    await runtime.shutdown();
  }
}

async function* fragments(...values: string[]) {
  yield* values;
}

function renderedCalls(calls: Array<{ input: NativeStreamCall }>) {
  return calls
    .flatMap(({ input }) => input.chunks ?? [])
    .map((chunk) => {
      expect(chunk.type).toBe("markdown_text");
      expect(typeof chunk.text).toBe("string");
      expect(chunk.text!.length).toBeLessThanOrEqual(12_000);
      expect(Buffer.from(chunk.text!, "utf8").toString("utf8")).toBe(
        chunk.text,
      );
      return chunk.text!;
    });
}

afterEach(() => vi.unstubAllGlobals());

describe("already-approved publication streaming", () => {
  it("bounds an unbroken paragraph after resolving cached normal-length Slack IDs", async () => {
    const text = "@x ".repeat(900) + "TAIL";
    expect(nativePublicationTextFits("slack", text)).toBe(true);
    await withNativeSlack(
      async ({ stream, calls, start, append, stop, post }) => {
        const result = await stream(streamSafePublicationText(text));
        expect(result.id).toBe(streamReceipt.ts);
        expect(renderedCalls(calls).join("")).toBe(
          "<@U0123456789> ".repeat(900) + "TAIL",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(append).toHaveBeenCalled();
        expect(stop).toHaveBeenCalledOnce();
        expect(post).not.toHaveBeenCalled();
      },
    );
  });

  it("accounts for a 255-character WebAPI residual before expanded text", async () => {
    const prefix = "r".repeat(253) + "\n\n";
    const text = "@x ".repeat(900) + "TAIL";
    await withNativeSlack(async ({ stream, calls }) => {
      const chunks = async function* () {
        yield prefix;
        expect(calls).toHaveLength(0); // The real WebAPI owns this buffered tail.
        yield text;
      };
      await stream(chunks());
      const rendered = renderedCalls(calls);
      expect(rendered.join("")).toBe(
        prefix + "<@U0123456789> ".repeat(900) + "TAIL",
      );
      expect(rendered[0].startsWith(prefix)).toBe(true);
      for (const part of rendered) {
        expect(part.match(/</g)?.length ?? 0).toBe(
          part.match(/>/g)?.length ?? 0,
        );
      }
    });
  });

  it.each([
    {
      label: "surrogate",
      text: "a".repeat(11_999) + "😀TAIL",
      expected: "a".repeat(11_999) + "😀TAIL",
    },
    {
      label: "entity",
      text: "a".repeat(11_999) + "&amp;TAIL",
      expected: "a".repeat(11_999) + "&amp;TAIL",
    },
    {
      label: "mention",
      text: "a".repeat(11_998) + " @x TAIL",
      expected: "a".repeat(11_998) + " <@U0123456789> TAIL",
    },
    {
      label: "fence",
      text: "```text\n" + "😀".repeat(6_100) + " @x\n```\n",
      expected: "```text\n" + "😀".repeat(6_100) + " @x\n```\n",
    },
  ])(
    "preserves exact $label boundaries in rendered chunks",
    async ({ text, expected }) => {
      await withNativeSlack(async ({ stream, calls }) => {
        await stream(fragments(text));
        const rendered = renderedCalls(calls);
        expect(rendered.join("")).toBe(expected);
        for (const part of rendered) {
          expect(part).not.toMatch(/&(?:a|am|l|g)?$/);
          expect(part).not.toMatch(/<[^>]*$/);
        }
      });
    },
  );

  it("awaits the stop receipt with an exact 255-character final buffer", async () => {
    await withNativeSlack(async ({ stream, calls, stop }) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      stop.mockImplementation(async (input) => {
        calls.push({ method: "stop", input });
        await held;
        return streamReceipt;
      });
      let settled = false;
      const pending = stream(
        fragments("p".repeat(300) + "\n\n", "t".repeat(255)),
      ).finally(() => {
        settled = true;
      });
      try {
        await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(stop.mock.calls[0][0].chunks).toEqual([
          { type: "markdown_text", text: "t".repeat(255) },
        ]);
      } finally {
        release();
      }
      expect((await pending).id).toBe(streamReceipt.ts);
      expect(renderedCalls(calls).join("")).toBe(
        "p".repeat(300) + "\n\n" + "t".repeat(255),
      );
    });
  });

  it("flushes an existing tail before a whole 12k Slack link token", async () => {
    const prefix = "p".repeat(253) + "\n\n";
    const token = "<https://example.test/" + "a".repeat(11_972) + "|safe>";
    expect(token.length).toBe(12_000);
    await withNativeSlack(async ({ stream, calls, start, append, post }) => {
      await stream(fragments(prefix, token));
      expect(renderedCalls(calls)).toEqual([prefix, token]);
      expect(start).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "refuses an unsplittable token without replay (accepted prefix=%s)",
    async (acceptedPrefix) => {
      const prefix = "p".repeat(300) + "\n\n";
      const token = "<https://example.test/" + "a".repeat(12_000) + "|safe>";
      await withNativeSlack(async ({ stream, calls, stop, post }) => {
        const error = await stream(
          fragments(...(acceptedPrefix ? [prefix, token] : [token])),
        ).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(classifyChatPublicationError(error, 1).kind).toBe(
          acceptedPrefix ? "delivery_unknown" : "failed",
        );
        expect(calls).toHaveLength(acceptedPrefix ? 1 : 0);
        expect(renderedCalls(calls).join("")).toBe(
          acceptedPrefix ? prefix : "",
        );
        expect(stop).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
      });
    },
  );

  it("does not replay an accepted prefix after a later rendered fragment is rejected", async () => {
    await withNativeSlack(async ({ stream, calls, append, stop, post }) => {
      append.mockImplementation(async (input) => {
        calls.push({ method: "append", input });
        if (append.mock.calls.length === 2)
          throw Object.assign(new Error("fragment rejected"), {
            code: "slack_webapi_platform_error",
            data: { ok: false, error: "invalid_chunks" },
          });
        return streamReceipt;
      });
      const error = await stream(fragments("@x ".repeat(2_000))).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(classifyChatPublicationError(error, 1).kind).toBe(
        "delivery_unknown",
      );
      expect(calls.map(({ method }) => method)).toEqual([
        "start",
        "append",
        "append",
      ]);
      expect(renderedCalls(calls).join("")).toBe(
        "<@U0123456789> ".repeat(2_000),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  it("keeps a post-prefix producer validation failure delivery-unknown", async () => {
    await withNativeSlack(async ({ stream, calls, stop, post }) => {
      const prefix = "Accepted prefix. ".repeat(30) + "\n\n";
      const chunks = async function* () {
        yield prefix;
        throw Object.assign(new Error("producer validation failed"), {
          name: "ValidationError",
          code: "VALIDATION_ERROR",
        });
      };
      const error = await stream(chunks()).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(classifyChatPublicationError(error, 1).kind).toBe(
        "delivery_unknown",
      );
      expect(renderedCalls(calls).join("")).toBe(prefix);
      expect(calls.map(({ method }) => method)).toEqual(["start"]);
      expect(stop).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  it("keeps a producer failure unknown after an accepted fallback post", async () => {
    await withNativeSlack(async ({ stream, start, post, stop }) => {
      start.mockRejectedValue(
        Object.assign(new Error("unsupported"), {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: "unknown_method" },
        }),
      );
      const chunks = async function* () {
        yield "Accepted fallback prefix. ".repeat(30) + "\n\n";
        throw Object.assign(new Error("producer validation failed"), {
          name: "ValidationError",
          code: "VALIDATION_ERROR",
        });
      };
      const error = await stream(chunks()).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(classifyChatPublicationError(error, 1).kind).toBe(
        "delivery_unknown",
      );
      expect(start).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    });
  });

  it("does not classify final status failure as an unsent accepted fallback", async () => {
    await withNativeSlack(async ({ stream, start, post, endTyping }) => {
      start.mockRejectedValue(
        Object.assign(new Error("unsupported"), {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: "unknown_method" },
        }),
      );
      endTyping.mockRejectedValue(
        Object.assign(new Error("status validation failed"), {
          name: "ValidationError",
        }),
      );
      const error = await stream(
        fragments("Approved fallback answer. ".repeat(30)),
      ).catch((failure: unknown) => failure);
      expect(classifyChatPublicationError(error, 1).kind).toBe(
        "delivery_unknown",
      );
      expect(start).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
      expect(endTyping).toHaveBeenCalledOnce();
    });
  });

  it.each([
    {
      label: "missing ok",
      status: 200,
      data: { error: "unknown_method" },
      expected: "delivery_unknown",
    },
    {
      label: "true ok but no ts",
      status: 200,
      data: { ok: true, error: "unknown_method" },
      expected: "delivery_unknown",
    },
    {
      label: "HTTP 503 with unsupported code",
      status: 503,
      data: { ok: false, error: "unknown_method" },
      expected: "delivery_unknown",
    },
    {
      label: "rate limit",
      status: 429,
      data: { ok: false, error: "ratelimited" },
      expected: "retry",
    },
  ])(
    "keeps actual WebAPI $label response coherent without HTTP retry or fallback",
    async ({ status, data, expected }) => {
      await withNativeSlack(async ({ stream, useHttp }) => {
        const methods: string[] = [];
        useHttp(async ({ method }) => {
          methods.push(method);
          if (method !== "chat.startStream")
            throw new Error("Unexpected second provider operation");
          return { status, data, headers: { "retry-after": "30" } };
        });
        const error = await stream(
          fragments("Approved answer. ".repeat(40)),
        ).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(classifyChatPublicationError(error, 1).kind).toBe(expected);
        expect(methods).toEqual(["chat.startStream"]);
      });
    },
  );

  it("permits coherent unsupported fallback through the actual WebAPI decoder", async () => {
    await withNativeSlack(async ({ stream, useHttp }) => {
      const methods: string[] = [];
      useHttp(async ({ method }) => {
        methods.push(method);
        if (method === "chat.startStream")
          return { status: 200, data: { ok: false, error: "unknown_method" } };
        expect(method).toBe("chat.postMessage");
        return { status: 200, data: streamReceipt };
      });
      expect(
        (await stream(fragments("Approved fallback answer. ".repeat(30)))).id,
      ).toBe(streamReceipt.ts);
      expect(methods).toEqual(["chat.startStream", "chat.postMessage"]);
    });
  });

  it("bounds actual serialized HTTP chunks after cached alias expansion", async () => {
    await withNativeSlack(async ({ stream, useHttp }) => {
      const calls: Array<{ method: string; input: NativeStreamCall }> = [];
      useHttp(async ({ method, body }) => {
        expect([
          "chat.startStream",
          "chat.appendStream",
          "chat.stopStream",
        ]).toContain(method);
        expect(body.get("channel")).toBe("D-PAPERCLIP");
        if (method === "chat.startStream")
          expect(body.get("thread_ts")).toBe("1788.400");
        else expect(body.get("ts")).toBe(streamReceipt.ts);
        calls.push({
          method,
          input: { chunks: JSON.parse(body.get("chunks") ?? "[]") },
        });
        return { status: 200, data: streamReceipt };
      });
      expect((await stream(fragments("@x ".repeat(900)))).id).toBe(
        streamReceipt.ts,
      );
      expect(renderedCalls(calls).join("")).toBe("<@U0123456789> ".repeat(900));
      expect(calls.map(({ method }) => method)).toEqual([
        "chat.startStream",
        "chat.appendStream",
        "chat.stopStream",
      ]);
    });
  });

  it.each([
    {
      label: "timeout",
      response: () => {
        throw new Error("socket timed out");
      },
    },
    {
      label: "HTTP 503",
      response: () => {
        throw Object.assign(new Error("service unavailable"), {
          code: "slack_webapi_http_error",
          statusCode: 503,
        });
      },
    },
    { label: "missing timestamp", response: () => ({ ok: true }) },
    {
      label: "foreign channel",
      response: () => ({ ...streamReceipt, channel: "D-OTHER" }),
    },
    {
      label: "false success",
      response: () => ({ ...streamReceipt, ok: false }),
    },
    {
      label: "partial internal error",
      response: () => {
        throw Object.assign(new Error("internal failure"), {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: "internal_error" },
        });
      },
    },
  ])(
    "never falls back or starts again after an unknown first $label",
    async ({ response }) => {
      await withNativeSlack(async ({ stream, start, append, stop, post }) => {
        start.mockImplementation(async () => response());
        const error = await stream(
          fragments(
            "First answer. ".repeat(40) + "\n\n",
            "Second paragraph. ".repeat(40),
          ),
        ).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(classifyChatPublicationError(error, 1).kind).toBe(
          "delivery_unknown",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(append).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
      });
    },
  );

  it("retains fallback only for a definite unsupported first native response", async () => {
    await withNativeSlack(async ({ stream, start, append, stop, post }) => {
      start.mockRejectedValue(
        Object.assign(new Error("unsupported"), {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: "unknown_method" },
        }),
      );
      expect((await stream(fragments("Safe answer. ".repeat(40)))).id).toBe(
        streamReceipt.ts,
      );
      expect(start).toHaveBeenCalledOnce();
      expect(append).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledOnce();
    });
  });

  it.each(["append", "stop"] as const)(
    "rejects a mismatched %s receipt without fallback or final proof",
    async (phase) => {
      await withNativeSlack(async ({ stream, append, stop, post }) => {
        (phase === "append" ? append : stop).mockResolvedValue({
          ...streamReceipt,
          ts: "1788.999",
        });
        const error = await stream(
          fragments("First. ".repeat(50) + "\n\n", "Second. ".repeat(50)),
        ).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(classifyChatPublicationError(error, 1).kind).toBe(
          "delivery_unknown",
        );
        if (phase === "append") expect(stop).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
      });
    },
  );

  it("does not reflush buffered text after an uncertain first structured send", async () => {
    await withNativeSlack(async ({ stream, start, append, stop, post }) => {
      start.mockRejectedValue(new Error("structured send timed out"));
      const chunks = async function* () {
        yield "Buffered approved text.\n\n";
        yield {
          type: "task_update",
          id: "task-1",
          title: "Working",
          status: "in_progress",
        };
        yield "Later answer. ".repeat(40);
      };
      const error = await stream(chunks()).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(classifyChatPublicationError(error, 1).kind).toBe(
        "delivery_unknown",
      );
      expect(start).toHaveBeenCalledOnce();
      expect(append).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  it("does not hide a malformed first receipt for short buffered output", async () => {
    await withNativeSlack(async ({ stream, start, stop, post }) => {
      start.mockResolvedValue({ ok: true });
      const error = await stream(fragments("Short answer.")).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(classifyChatPublicationError(error, 1).kind).toBe(
        "delivery_unknown",
      );
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: "ordinary text", text: source, expected: source },
    {
      label: "many paragraphs",
      text: "Result here.\n\n".repeat(350) + "TAIL",
      expected: "Result here.\n\n".repeat(350) + "TAIL",
    },
    {
      label: "cached mentions",
      text: "@x result. ".repeat(250) + "TAIL",
      expected: "<@U0123456789> result. ".repeat(250) + "TAIL",
    },
    {
      label: "expanding cached mentions",
      text: "@x\n\n".repeat(499),
      expected: `<@U${"A".repeat(20)}>\n\n`.repeat(499),
      cachedUserId: `U${"A".repeat(20)}`,
    },
    {
      label: "astral and fenced text",
      text: "😀".repeat(1_100) + "\n\n```text\n@x stays literal\n```\n\nTAIL",
      expected:
        "😀".repeat(1_100) + "\n\n```text\n@x stays literal\n```\n\nTAIL",
    },
  ])(
    "finishes native Slack $label without artificial producer delays",
    async ({ text, expected, cachedUserId }) => {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "ready-slack-company",
        endpointId: "ready-slack-endpoint",
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "slack",
          userName: "paperclip-agent",
          credentials: {
            botToken: "xoxb-test",
            botUserId: "U-BOT",
            signingSecret: "test",
          },
        },
      });
      try {
        await runtime.initialize();
        type StreamCall = { chunks: Array<{ type: string; text: string }> };
        const calls: StreamCall[] = [];
        const accept = async (input: StreamCall) => {
          calls.push(input);
          return { ok: true, ts: "1788.901" };
        };
        const start = vi.fn(accept);
        const append = vi.fn(accept);
        const stop = vi.fn(accept);
        const adapter = runtime.getProviderAdapter() as unknown as {
          _client: {
            chat: {
              startStream: unknown;
              appendStream: unknown;
              stopStream: unknown;
            };
          };
          chat: { getState(): { getList(key: string): Promise<string[]> } };
          stream(
            threadId: string,
            chunks: AsyncIterable<string>,
          ): Promise<{ id: string }>;
        };
        // Keep the real pinned Web API ChatStreamer buffer/serialization path.
        adapter._client.chat.startStream = start;
        adapter._client.chat.appendStream = append;
        adapter._client.chat.stopStream = stop;
        vi.spyOn(adapter.chat.getState(), "getList").mockImplementation(
          async (key) =>
            key === "slack:user-by-name:x"
              ? [cachedUserId ?? "U0123456789"]
              : [],
        );
        const wait = vi.fn(async (_delayMs: number) => undefined);
        const result = await adapter.stream(
          "slack:D-PAPERCLIP:1788.400",
          streamSafePublicationText(text, { wait }),
        );
        expect(result.id).toBe("1788.901");
        expect(start).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
        expect(calls.length).toBeLessThanOrEqual(
          Math.ceil(
            Array.from(text).length / (/[@&]/.test(text) ? 280 : 2_000),
          ) + 1,
        );
        expect(
          calls
            .flatMap((input) => input.chunks)
            .map((chunk) => chunk.text)
            .join(""),
        ).toBe(expected);
        expect(
          calls.every((input) =>
            input.chunks.every(
              (chunk) =>
                chunk.type === "markdown_text" && chunk.text.length <= 12_000,
            ),
          ),
        ).toBe(true);
        expect(wait).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each(["private", "supergroup"] as const)(
    "preserves Telegram %s delivery and provider pacing without artificial producer delays",
    async (chatType) => {
      const chatId = chatType === "private" ? 123 : -100123;
      const requests: Array<{ method: string; body: Record<string, unknown> }> =
        [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const method = String(url).split("/").at(-1)!;
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          requests.push({ method, body });
          return Response.json({
            ok: true,
            result: method.endsWith("Draft")
              ? true
              : {
                  message_id: 901,
                  date: 1788910000,
                  chat: { id: chatId, type: chatType },
                  from: { id: 123, is_bot: true, first_name: "Paperclip" },
                  text: source,
                },
          });
        }),
      );
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "ready-telegram-company",
        endpointId: "ready-telegram-endpoint",
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "telegram",
          userName: "paperclip_agent_bot",
          credentials: { botToken: "123:test", secretToken: "test" },
        },
      });
      try {
        const adapter = runtime.getProviderAdapter() as unknown as {
          sleep(ms: number): Promise<void>;
          stream(
            threadId: string,
            chunks: AsyncIterable<string>,
          ): Promise<{ id: string }>;
        };
        const providerPacing = vi.fn(async (_delayMs: number) => undefined);
        adapter.sleep = providerPacing;
        const wait = vi.fn(async (_delayMs: number) => undefined);
        const result = await adapter.stream(
          `telegram:${chatId}`,
          streamSafePublicationText(source, { wait }),
        );
        expect(result.id).toBe(`${chatId}:901`);
        const drafts = requests.filter(
          ({ method }) => method === "sendRichMessageDraft",
        );
        if (chatType === "private") {
          expect(drafts.length).toBeGreaterThan(0);
          expect(drafts.length).toBeLessThanOrEqual(2);
          const final = requests.filter(
            ({ method }) => method === "sendRichMessage",
          );
          expect(final).toHaveLength(1);
          expect(final[0].body.rich_message).toEqual({
            markdown: source.trimEnd(),
          });
          expect(providerPacing).not.toHaveBeenCalled();
        } else {
          expect(drafts).toHaveLength(0);
          // The SDK's own final-edit rate-limit pacing must not be removed.
          expect(providerPacing).toHaveBeenCalledOnce();
          expect(providerPacing.mock.calls[0][0]).toBeGreaterThan(0);
          expect(requests.at(-1)?.method).toBe("editMessageText");
          expect(requests.at(-1)?.body.rich_message).toEqual({
            markdown: source.trimEnd(),
          });
        }
        expect(wait).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );
});
