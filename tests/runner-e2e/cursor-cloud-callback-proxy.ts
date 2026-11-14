import { createServer } from "node:http";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../../packages/paperclip-runner/src/drivers/runner-tool-bridge.js";

export async function startCursorCloudCallbackProxy(input: { port: number; appPort: number }) {
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535 || input.port === input.appPort) throw new Error("Cursor Cloud requires a distinct callback-only loopback port");
  const server = createServer(async (request, response) => {
    const callbackPath = /^\/mcp\/native-runs\/[a-f0-9-]{36}$/u.test(request.url ?? "");
    if (request.method === "GET" && callbackPath) {
      response.writeHead(405, { Allow: "POST" }).end(); request.resume(); return;
    }
    if (request.method !== "POST" || !callbackPath) {
      response.writeHead(404).end(); request.resume(); return;
    }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const key of ["authorization", "mcp-session-id", "mcp-protocol-version", RUNNER_TOOL_SCOPE_TOKEN_HEADER]) {
        const value = request.headers[key]; if (typeof value === "string") headers[key] = value;
      }
      const upstream = await fetch(`http://127.0.0.1:${input.appPort}${request.url}`, {
        method: "POST", headers, body: Buffer.concat(chunks), redirect: "error", signal: AbortSignal.timeout(65_000),
      });
      response.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store", ...(upstream.headers.get("mcp-session-id") ? { "mcp-session-id": upstream.headers.get("mcp-session-id")! } : {}) });
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
  });
  server.requestTimeout = 70_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.port, "127.0.0.1", resolve); });
  return async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
}

export async function assertCursorCloudCallbackIngress(origin: string, fetcher: typeof fetch = fetch) {
  for (const [path, status, method] of [["/", 404, "GET"], ["/api/health", 404, "GET"], ["/mcp/native-runs/00000000-0000-4000-8000-000000000000", 401, "POST"]] as const) {
    const response = await fetcher(new URL(path, origin), { method, redirect: "error", signal: AbortSignal.timeout(10_000), ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    await response.body?.cancel();
    if (response.status !== status) throw new Error("Cursor Cloud acceptance setup-blocked: public origin must expose only /mcp/native-runs/ through the dedicated callback listener");
  }
}
