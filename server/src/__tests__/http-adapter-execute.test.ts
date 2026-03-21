import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../adapters/http/execute.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

// Capture fetch calls
const fetchSpy = vi.fn<typeof globalThis.fetch>();

function makeCtx(overrides: Partial<AdapterExecutionContext["config"]> = {}): AdapterExecutionContext {
  return {
    config: {
      url: "https://example.com/hook",
      method: "POST",
      ...overrides,
    },
    runId: "run-1",
    agent: { id: "agent-1" } as any,
    context: { prompt: "hello" },
  } as any;
}

describe("HTTP adapter execute", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends body for POST requests", async () => {
    await execute(makeCtx({ method: "POST" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts?.method).toBe("POST");
    expect(opts?.body).toBeDefined();
    expect(JSON.parse(opts!.body as string)).toMatchObject({ agentId: "agent-1" });
    expect((opts?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("omits body for GET requests (#1335)", async () => {
    await execute(makeCtx({ method: "GET" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts?.method).toBe("GET");
    expect(opts?.body).toBeUndefined();
  });

  it("omits body for HEAD requests (#1335)", async () => {
    await execute(makeCtx({ method: "HEAD" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts?.method).toBe("HEAD");
    expect(opts?.body).toBeUndefined();
  });

  it("normalizes lowercase method to uppercase", async () => {
    await execute(makeCtx({ method: "get" }));

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts?.method).toBe("GET");
    expect(opts?.body).toBeUndefined();
  });

  it("does not set content-type for bodyless methods", async () => {
    await execute(makeCtx({ method: "GET" }));

    const [, opts] = fetchSpy.mock.calls[0];
    const headers = opts?.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
  });

  it("defaults to POST when method is not specified", async () => {
    await execute(makeCtx({ method: undefined }));

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts?.method).toBe("POST");
    expect(opts?.body).toBeDefined();
  });
});
