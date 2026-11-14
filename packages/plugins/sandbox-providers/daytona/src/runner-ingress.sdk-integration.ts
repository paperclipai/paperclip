import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRequest, definePlugin, isJsonRpcResponse, JsonRpcCallError, parseMessage,
  readEnvironmentRunnerIngressFailure, serializeMessage, startWorkerRpcHost, type JsonRpcResponse } from "@paperclipai/plugin-sdk";
import plugin, { __resetDaytonaSandboxHandleCacheForTest } from "./plugin.js";

describe("Daytona ingress SDK failure over worker RPC", () => {
  it("keeps a missing API credential as a configuration failure", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "");
    try {
      const error = await plugin.definition.onEnvironmentRunnerIngressEndpoint!({
        companyId: "fixture-company", environmentId: "fixture-environment", driverKey: "daytona",
        runId: "fixture-run", port: 43127, path: "/api/runner/v1/connect/fixture-run",
        lease: { providerLeaseId: "fixture-sandbox" }, config: {},
      } as never).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("require an API key");
      expect(readEnvironmentRunnerIngressFailure(error)).toBeNull();
    } finally { vi.unstubAllEnvs(); __resetDaytonaSandboxHandleCacheForTest(); }
  });
  it.each([
    { status: 502, phase: "sandbox_lookup" }, { status: 401, phase: "sandbox_lookup" },
    { status: 403, phase: "sandbox_lookup" }, { status: 400, phase: "sandbox_lookup" },
    { status: 502, phase: "private_preview" },
  ])("retains the pinned SDK's HTTP $status at $phase without provider response data", async ({ status, phase }) => {
    let requests = 0;
    let apiUrl = "";
    const server = createServer((request, response) => {
      requests++;
      if (phase === "private_preview" && !request.url?.includes("43127")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "fixture-sandbox", name: "fixture-sandbox", organizationId: "fixture-org",
          state: "started", toolboxProxyUrl: apiUrl, labels: {}, autoStopInterval: 0 }));
        return;
      }
      response.writeHead(status, { "content-type": "text/html", "x-private-token": "fixture-private-header" });
      response.end(`<html><title>${status} Bad Gateway</title>fixture-private-url fixture-private-token</html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    apiUrl = `http://127.0.0.1:${address.port}`;
    const stdin = new PassThrough(), stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({ async setup() {},
      onEnvironmentRunnerIngressEndpoint: plugin.definition.onEnvironmentRunnerIngressEndpoint,
    }) });
    try {
      const response = new Promise<JsonRpcResponse>(resolve => lines.on("line", line => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      }));
      stdin.write(serializeMessage(createRequest("environmentRunnerIngressEndpoint", {
        companyId: "fixture-company", environmentId: "fixture-environment", driverKey: "daytona",
        runId: "fixture-run", port: 43127, path: "/api/runner/v1/connect/fixture-run",
        lease: { providerLeaseId: "fixture-sandbox" },
        config: { apiKey: "fixture-private-key", apiUrl, timeoutMs: 2000 },
      }, "ingress")));
      const result = await response;
      expect(requests).toBeGreaterThan(0);
      if (!("error" in result) || !result.error) throw new Error("Expected SDK rejection");
      expect(readEnvironmentRunnerIngressFailure(new JsonRpcCallError(result.error)))
        .toEqual({ phase, httpStatus: status });
      expect(result.error.message).toContain(String(status));
      expect(JSON.stringify(result)).not.toContain("fixture-private");
      expect(result.error.data).toEqual({ schema: "paperclip/environment-runner-ingress-error/v1",
        failure: { phase, httpStatus: status } });
    } finally {
      worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      __resetDaytonaSandboxHandleCacheForTest();
    }
  });
});
