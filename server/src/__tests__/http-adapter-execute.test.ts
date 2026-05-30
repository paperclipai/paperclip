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

  it("includes remote error detail when the endpoint fails", async () => {
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
        config: { url, method: "POST" },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow("HTTP invoke failed with status 502: bridge unavailable");
  });
});
