import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeExportHeartbeatRunToLangfuse } from "./langfuse-export.js";

describe("langfuse export", () => {
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, envSnapshot);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no-ops when disabled", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, _init?: RequestInit) =>
      ({ ok: true, status: 200, statusText: "OK" } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    process.env.LANGFUSE_HOST = "http://127.0.0.1:3001";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";

    await maybeExportHeartbeatRunToLangfuse({
      run: { id: "run-1" },
      issue: { id: "issue-1" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when run is not issue-scoped", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, _init?: RequestInit) =>
      ({ ok: true, status: 200, statusText: "OK" } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    process.env.PAPERCLIP_LANGFUSE_ENABLED = "1";
    process.env.LANGFUSE_HOST = "http://127.0.0.1:3001";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";

    await maybeExportHeartbeatRunToLangfuse({
      run: { id: "run-1" },
      issue: null,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a minimal trace payload when configured", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, _init?: RequestInit) =>
      ({ ok: true, status: 200, statusText: "OK" } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    process.env.PAPERCLIP_LANGFUSE_ENABLED = "true";
    process.env.LANGFUSE_HOST = "http://127.0.0.1:3001/";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.PAPERCLIP_LANGFUSE_ENVIRONMENT = "Production";

    await maybeExportHeartbeatRunToLangfuse({
      companyId: "company-1",
      run: {
        id: "run-1",
        status: "succeeded",
        startedAt: "2026-05-10T10:00:00.000Z",
        finishedAt: "2026-05-10T10:01:00.000Z",
      },
      agent: { id: "agent-1", name: "Odin", adapterType: "codex_local" },
      issue: { id: "issue-1", identifier: "ARG-206", title: "Upstream Langfuse export" },
      adapterResult: { provider: "openai", model: "gpt-5.2", billingType: "api", costUsd: 0.25, exitCode: 0 },
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
      promptVersion: "rev-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] ?? [undefined, undefined];
    expect(url).toBe("http://127.0.0.1:3001/api/public/ingestion");
    expect(options?.method).toBe("POST");
    expect((options?.headers as Record<string, string> | undefined)?.authorization).toBe(
      `Basic ${Buffer.from("pk-test:sk-test", "utf8").toString("base64")}`,
    );

    const body = JSON.parse(String(options?.body));
    expect(body.batch).toHaveLength(3);
    expect(body.batch.map((event: { type: string }) => event.type)).toEqual([
      "trace-create",
      "generation-create",
      "score-create",
    ]);

    const trace = body.batch.find((event: { type: string }) => event.type === "trace-create")?.body;
    expect(trace.id).toBe("run-1");
    expect(trace.sessionId).toBe("issue-1");
    expect(trace.name).toBe("paperclip.heartbeat_run");
    expect(trace.environment).toBe("production");

    const generation = body.batch.find((event: { type: string }) => event.type === "generation-create")?.body;
    expect(generation.traceId).toBe("run-1");
    expect(generation.name).toBe("paperclip.run");
    expect(generation.costDetails.total).toBe(0.25);

    const score = body.batch.find((event: { type: string }) => event.type === "score-create")?.body;
    expect(score.traceId).toBe("run-1");
    expect(score.name).toBe("paperclip.outcome");
    expect(score.value).toBe(1);
    expect(score.observationId).toBe(generation.id);
  });
});
