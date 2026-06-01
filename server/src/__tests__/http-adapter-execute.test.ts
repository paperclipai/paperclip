import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../adapters/http/execute.js";

const servers: Array<{ close: () => void }> = [];

function startJsonServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected tcp server address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("http adapter execute", () => {
  it("returns response JSON so remote bridge output is visible to Paperclip", async () => {
    const url = await startJsonServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, summary: "Hermes profile florence exited 0", output: "DONE" }));
    });

    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", name: "Florence", adapterType: "http", adapterConfig: {} },
      runtime: { id: "runtime-1", type: "local", label: "test" },
      config: { url, method: "POST" },
      context: { issue: { title: "Discovery sprint" } },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Hermes profile florence exited 0");
    expect(result.resultJson).toMatchObject({ ok: true, output: "DONE" });
  });

  it("includes remote error detail when the endpoint fails (maxAttempts=1, no retry)", async () => {
    const url = await startJsonServer((_req, res) => {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "bridge unavailable" }));
    });

    await expect(
      execute({
        runId: "run-1",
        agent: { id: "agent-1", name: "Florence", adapterType: "http", adapterConfig: {} },
        runtime: { id: "runtime-1", type: "local", label: "test" },
        config: { url, method: "POST", maxAttempts: 1 },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow("HTTP invoke failed with status 502: bridge unavailable");
  });

  it("retries a transient 502 and succeeds on the next attempt", async () => {
    let calls = 0;
    const url = await startJsonServer((_req, res) => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      if (calls === 1) {
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false, error: "worker respawning" }));
        return;
      }
      res.end(JSON.stringify({ ok: true, summary: "Hermes profile editor exited 0", output: "DONE" }));
    });

    const result = await execute({
      runId: "run-retry",
      agent: { id: "agent-1", name: "Editor", adapterType: "http", adapterConfig: {} },
      runtime: { id: "runtime-1", type: "local", label: "test" },
      config: { url, method: "POST", retryBackoffMs: 1 },
      context: {},
      onLog: async () => {},
    });

    expect(calls).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Hermes profile editor exited 0");
  });

  it("gives up after maxAttempts on a persistent transient failure (bounded retry)", async () => {
    let calls = 0;
    const url = await startJsonServer((_req, res) => {
      calls += 1;
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "still down" }));
    });

    await expect(
      execute({
        runId: "run-giveup",
        agent: { id: "agent-1", name: "Editor", adapterType: "http", adapterConfig: {} },
        runtime: { id: "runtime-1", type: "local", label: "test" },
        config: { url, method: "POST", maxAttempts: 2, retryBackoffMs: 1 },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow("HTTP invoke failed with status 503: still down");
    expect(calls).toBe(2);
  });
});
