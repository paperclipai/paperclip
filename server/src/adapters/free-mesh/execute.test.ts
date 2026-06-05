import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { FREE_MESH_DATA_POLICY } from "./constants.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("free-mesh adapter execute", () => {
  it("routes a low-stakes prompt through OpenAI-compatible chat completions", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "swarm-public",
          choices: [{ message: { content: "validation complete" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const metas: unknown[] = [];

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Mesh Validator",
        adapterType: "free-mesh",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "https://litellm.example/v1",
        apiKey: "mesh-key",
        model: "swarm-public",
        dataPolicy: FREE_MESH_DATA_POLICY,
        temperature: 0,
      },
      context: {
        issue: {
          identifier: "TWX-178",
          title: "Validate public adapter wiring",
        },
      },
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
      authToken: "paperclip-agent-jwt-must-not-leak",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://litellm.example/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer mesh-key",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "swarm-public",
      temperature: 0,
    });
    expect(body.messages[0].content).toContain("low-stakes public-data");
    expect(body.messages[1].content).toContain("TWX-178");
    expect(JSON.stringify(body)).not.toContain("paperclip-agent-jwt-must-not-leak");

    expect(logs).toEqual([{ stream: "stdout", chunk: "validation complete\n" }]);
    expect(metas[0]).toMatchObject({
      adapterType: "free-mesh",
      env: {
        FREE_MESH_BASE_URL: "https://litellm.example/v1",
        FREE_MESH_API_KEY: "[redacted]",
      },
    });
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      provider: "free-mesh",
      biller: "free-mesh",
      billingType: "credits",
      costUsd: 0,
      model: "swarm-public",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    });
  });

  it("refuses to run without the explicit low-stakes public data policy", async () => {
    await expect(
      execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Mesh Validator",
          adapterType: "free-mesh",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          baseUrl: "https://litellm.example/v1",
          apiKey: "mesh-key",
        },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow('free-mesh requires dataPolicy="low_stakes_public_only"');
  });
});
