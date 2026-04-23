import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

function createContext(overrides: Partial<any> = {}) {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const metas: any[] = [];

  const ctx: any = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Abner",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "http://hermes-service:8642/v1",
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "issue_assigned",
    },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (meta: any) => {
      metas.push(meta);
    },
    ...overrides,
  };

  return { ctx, logs, metas };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hermes_gateway execute", () => {
  it("derives chat completions from a /v1 base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          object: "chat.completion",
          model: "mimo",
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, metas } = createContext({
      config: {
        url: "http://hermes-service:8642/v1",
        apiMode: "chat_completions",
      },
    });

    const result = await execute(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://hermes-service:8642/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: false,
      messages: expect.any(Array),
    });
    expect(metas[0]?.commandArgs).toEqual(
      expect.arrayContaining(["--api-mode", "chat_completions"]),
    );
    expect(result.summary).toBe("hello");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.sessionParams).toBeNull();
  });

  it("derives responses endpoint and issue-scoped conversation from a /v1 base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp-1",
          model: "mimo",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, metas } = createContext({
      config: {
        url: "http://hermes-service:8642/v1",
        apiMode: "responses",
        sessionKeyStrategy: "issue",
      },
    });

    const result = await execute(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://hermes-service:8642/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      stream: false,
      store: true,
      conversation: "paperclip:agent:agent-1:issue:issue-1",
      input: expect.any(String),
      instructions: expect.stringContaining("paperclip_*"),
    });
    expect(metas[0]?.commandArgs).toEqual(
      expect.arrayContaining([
        "--api-mode",
        "responses",
        "--conversation",
        "paperclip:agent:agent-1:issue:issue-1",
      ]),
    );
    expect(result.summary).toBe("done");
    expect(result.sessionDisplayId).toBe("paperclip:agent:agent-1:issue:issue-1");
    expect(result.sessionParams).toEqual({
      apiMode: "responses",
      conversation: "paperclip:agent:agent-1:issue:issue-1",
      lastResponseId: "resp-1",
    });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
  });

  it("respects legacy full endpoint URLs for backwards compatibility", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp-2",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createContext({
      config: {
        url: "http://hermes-service:8642/v1/chat/completions",
        apiMode: "responses",
      },
    });

    await execute(ctx);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe("http://hermes-service:8642/v1/responses");
  });

  it("supports fixed session keys in responses mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp-3",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "fixed" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createContext({
      config: {
        url: "http://hermes-service:8642/v1",
        apiMode: "responses",
        sessionKeyStrategy: "fixed",
        sessionKey: "paperclip:agent:abner",
      },
    });

    const result = await execute(ctx);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.conversation).toBe("paperclip:agent:abner");
    expect(result.sessionDisplayId).toBe("paperclip:agent:abner");
  });

  it("warns when fixed session strategy is selected without a session key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp-4",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "warned" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, logs } = createContext({
      config: {
        url: "http://hermes-service:8642/v1",
        apiMode: "responses",
        sessionKeyStrategy: "fixed",
        sessionKey: "",
      },
    });

    const result = await execute(ctx);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.conversation).toBe("paperclip:agent:agent-1");
    expect(result.sessionDisplayId).toBe("paperclip:agent:agent-1");
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("fixed session strategy requires adapterConfig.sessionKey"),
        }),
      ]),
    );
  });

  it("omits the model field when no override is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          object: "chat.completion",
          choices: [{ message: { content: "no-model" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createContext({
      config: {
        url: "http://hermes-service:8642/v1",
        apiMode: "chat_completions",
        model: "",
      },
    });

    await execute(ctx);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBeUndefined();
  });
});
