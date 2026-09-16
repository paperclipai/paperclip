import { request as proxyRequest, createServer } from "node:http";

import {
  resolveScenarioChatProxyConfig,
  selectedScenarioChatProxyHeaders,
} from "./scenario-chat-proxy-config.js";

const MAX_BODY_BYTES = 64 * 1024;

function main(): void {
  const { socketPath, port, bindHost, publicOrigin } = resolveScenarioChatProxyConfig(process.env);

  const server = createServer((req, res) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      res.writeHead(413, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end('{"error":{"code":"request_too_large","message":"Request body exceeds the 64 KiB limit."}}');
      return;
    }

    const upstream = proxyRequest({
      socketPath,
      method: req.method,
      path: req.url,
      headers: selectedScenarioChatProxyHeaders(req.headers, publicOrigin, req.socket.remoteAddress),
      timeout: 35_000,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.once("error", () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end('{"error":{"code":"upstream_unavailable","message":"Demo service is unavailable."}}');
    });
    req.pipe(upstream);
  });
  server.maxConnections = 32;
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, bindHost);

  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "proxy_startup_failed",
    code: error instanceof Error ? error.name : "Error",
  })}\n`);
  process.exitCode = 1;
}
