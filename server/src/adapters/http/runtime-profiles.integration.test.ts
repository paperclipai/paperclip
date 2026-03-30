import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import type { AdapterExecutionContext } from "../types.js";

function buildBaseContext(url: string): AdapterExecutionContext {
  return {
    runId: "RUN-TEST",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "http-test-agent",
      adapterType: "http",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url,
      method: "POST",
      runtimeProfile: "http+crewai",
      headers: { "x-agent-runtime": "CrewAI" },
    },
    context: { wakeReason: "test" },
    onLog: async () => undefined,
  };
}

describe("http runtime profiles integration", () => {
  it("execute captures JSON body for runtime contract checks", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ runtime: { framework: "CrewAI", installed: true, version: "0.5.0" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");

    const result = await execute(buildBaseContext(`http://127.0.0.1:${address.port}/webhook`));
    server.close();

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      runtime: { framework: "CrewAI", installed: true, version: "0.5.0" },
    });
  });

  it("testEnvironment reports CrewAI runtime profile checks", async () => {
    const server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "http",
      config: {
        url: `${baseUrl}/webhook`,
        method: "POST",
        runtimeProfile: "http+crewai",
        headers: { "x-agent-runtime": "CrewAI" },
      },
    });
    server.close();

    const codes = new Set(result.checks.map((check) => check.code));
    expect(codes.has("http_runtime_profile_crewai")).toBe(true);
    expect(codes.has("http_crewai_health_probe_ok")).toBe(true);
  });
});
