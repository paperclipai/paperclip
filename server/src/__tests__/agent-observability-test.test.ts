import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import protobuf from "protobufjs";
import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE } from "@paperclipai/shared";
import { testAgentObservability } from "../services/agent-observability-test.js";

let server: Server, endpoint: string;
let responseMode = "success";
const requests: Array<{ path: string; headers: Record<string, unknown>; body: Buffer }> = [];
let root: protobuf.Root;
beforeAll(async () => {
  root = protobuf.parse(await readFile(new URL("./fixtures/otlp-observability.proto", import.meta.url), "utf8")).root;
  server = createServer(async (req, res) => {
    // Fault scenarios must not leave pooled sockets for the next scenario.
    res.setHeader("connection", "close");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    if (responseMode === "hang") return;
    if (responseMode === "body-hang") { res.writeHead(200, { "content-type": "application/x-protobuf" }); res.write(Buffer.from([10])); return; }
    if (responseMode === "delayed") { setTimeout(() => { res.writeHead(200); res.end(); }, 150); return; }
    if (responseMode === "oversize") { res.writeHead(200, { "content-type": "application/x-protobuf" }); res.end(Buffer.alloc(65537)); return; }
    if (/^status-\d+$/.test(responseMode)) { res.writeHead(Number(responseMode.slice(7))); res.end("untrusted-secret-error"); return; }
    if (responseMode === "reject") { res.writeHead(403); res.end("secret provider diagnostic must not escape"); return; }
    if (responseMode === "malformed") { res.writeHead(200, { "content-type": "application/json" }); res.end("malformed"); return; }
    if (responseMode === "bad-shape") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"partialSuccess":"invalid"}'); return; }
    if (responseMode === "html") { res.writeHead(200, { "content-type": "text/html" }); res.end(); return; }
    if (responseMode === "json-partial") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ partialSuccess: { [req.url?.endsWith("logs") ? "rejectedLogRecords" : "rejectedSpans"]: "1", errorMessage: "untrusted-secret-error" } })); return; }
    if (responseMode === "partial") {
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      const type = root.lookupType("paperclip.test.otlp.ExportResponse");
      res.end(type.encode(type.create({ partialSuccess: { rejectedLogRecords: 1, errorMessage: "untrusted-secret-error" } })).finish()); return;
    }
    res.writeHead(200, { "content-type": "application/x-protobuf" }); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function run(timeoutMs?: number, allowPrivateNetwork = true) {
  return testAgentObservability({ companyId: "10000000-0000-4000-8000-000000000001", revision: "20000000-0000-4000-8000-000000000001", timeoutMs, allowPrivateNetwork,
    resolved: { state: "enabled", revision: "20000000-0000-4000-8000-000000000001", compatibilityKey: "test", logsEndpoint: `${endpoint}/otel/v1/logs`, tracesEndpoint: `${endpoint}/otel/v1/traces`,
      headers: { authorization: "Bearer local-fixture", "x-bt-parent": "project_id:fixture" }, capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE } } });
}
it("sends actual protobuf records with one root span, correlated IDs, and exact routing", async () => {
  responseMode = "success"; requests.length = 0;
  const result = await run(); expect(result.status).toBe("accepted");
  expect(requests.map(row => row.path).sort()).toEqual(["/otel/v1/logs", "/otel/v1/traces"]);
  for (const req of requests) expect(req.headers).toMatchObject({ authorization: "Bearer local-fixture", "x-bt-parent": "project_id:fixture", "content-type": "application/x-protobuf" });
  const logs = root.lookupType("paperclip.test.otlp.ExportLogsServiceRequest").decode(requests.find(row => row.path.endsWith("logs"))!.body).toJSON();
  const traces = root.lookupType("paperclip.test.otlp.ExportTraceServiceRequest").decode(requests.find(row => row.path.endsWith("traces"))!.body).toJSON();
  const log = logs.resourceLogs[0].scopeLogs[0].logRecords[0], span = traces.resourceSpans[0].scopeSpans[0].spans[0];
  expect(log.body.stringValue).toBe(result.marker); expect(log.traceId).toBe(span.traceId); expect(log.spanId).toBe(span.spanId);
  expect(span.parentSpanId).toBeUndefined(); expect(span.name).toBe("paperclip.observability.connection_test");
});
it.each(["reject", "malformed", "bad-shape", "html", "partial", "json-partial"])("reports %s without echoing receiver data", async mode => {
  responseMode = mode; const result = await run();
  expect(result.status).toBe(mode.includes("partial") ? "partial" : "failed");
  expect(JSON.stringify(result)).not.toContain("untrusted-secret"); expect(JSON.stringify(result)).not.toContain("must not escape");
});
it("aborts a receiver that accepts connections and never responds", async () => {
  responseMode = "hang"; const start = performance.now(); const result = await run(100);
  expect(result.status).toBe("failed"); expect(result.signals.logs.errorCode).toBe("timeout");
  expect(performance.now() - start).toBeLessThan(2000); server.closeAllConnections();
});
it.each([401, 403, 404, 429, 500])("sanitizes HTTP %s without retrying", async status => {
  responseMode = `status-${status}`; requests.length = 0;
  const result = await run();
  expect(requests).toHaveLength(2);
  expect(result.signals.logs).toMatchObject({ status: "failed", httpStatus: status, errorCode: "receiver_rejected" });
  expect(JSON.stringify(result)).not.toContain("untrusted-secret");
});
it.each(["body-hang", "delayed"])("uses the shared deadline for %s", async mode => {
  responseMode = mode;
  const result = await run(50);
  expect(result.signals.logs.errorCode).toBe("timeout");
  expect(result.signals.traces.errorCode).toBe("timeout");
  server.closeAllConnections();
});
it("rejects a response larger than 64 KiB", async () => {
  responseMode = "oversize";
  expect((await run()).status).toBe("failed");
});
it("denies private endpoints in public mode without delivering a request", async () => {
  responseMode = "success"; requests.length = 0;
  expect((await run(1000, false)).status).toBe("failed"); expect(requests).toHaveLength(0);
});
