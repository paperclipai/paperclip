import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "@paperclipai/adapter-otto-agent/server";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "Otto Agent",
      adapterType: "otto_agent",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("otto agent adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefers the Builder prompt when executionMode is builder", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          ok: true,
          summary: String(body.prompt ?? ""),
          sessionId: "session-1",
          model: "copilot/claude-sonnet-4-5",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext(
        {
          url: "https://otto.example/api/paperclip",
          apiKey: "otto-secret",
        },
        {
          context: {
            executionMode: "builder",
            prompt: "Return strict JSON only.",
            instructions: "ignored fallback",
          },
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(String(requestBody.prompt)).toContain("Return strict JSON only.");
    expect(String(requestBody.prompt).startsWith("Return strict JSON only.")).toBe(true);
  });
});
