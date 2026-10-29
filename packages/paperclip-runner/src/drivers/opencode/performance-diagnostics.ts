import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  MAX_PROVIDER_PERFORMANCE_SPANS, PROVIDER_PERFORMANCE_DIAGNOSTIC,
  type ProviderPerformancePhase, type ProviderPerformanceSpan,
} from "../../contracts/provider-performance.js";

const phases: Readonly<Record<string, ProviderPerformancePhase>> = {
  "SystemPrompt.environment": "provider.context.environment",
  "Instruction.system": "provider.context.instructions",
  "Skill.discovery": "provider.skills.discovery",
  "SessionTools.resolve": "provider.tools.resolve",
  "Provider.getModel": "provider.model.resolve",
  "ai.streamText": "provider.model.stream",
  "Snapshot.track": "provider.workspace.snapshot.track",
  "Snapshot.patch": "provider.workspace.snapshot.patch",
  "Snapshot.diffFull": "provider.workspace.snapshot.diff",
  "Git.repo.discover": "provider.workspace.git.discover",
  "Git.defaultBranch": "provider.workspace.git.default_branch",
  "Npm.install": "provider.dependencies.install",
  "PluginInternal.boot": "provider.plugins.initialize",
};
const maxBodyBytes = 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** OpenCode's raw OTLP can contain authorization and prompt attributes. None leave this sink. */
export async function startOpenCodePerformanceDiagnostics(companyEnvironment?: NodeJS.ProcessEnv, collectPerformance = true, onUnavailable?: (reason: "capacity" | "batch_limit" | "destination") => void) {
  const destination = openCodeTraceDestination(companyEnvironment);
  const pending = new Map<Promise<unknown>, AbortController>();
  let closed = false;
  const reported = new Set<string>();
  const report = (reason: "capacity" | "batch_limit" | "destination") => {
    if (closed || reported.has(reason)) return;
    reported.add(reason);
    try { onUnavailable?.(reason); } catch {}
  };
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const spans: ProviderPerformanceSpan[] = [];
  const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) {
      request.resume(); response.writeHead(401).end(); return;
    }
    if (request.method !== "POST" || !["/v1/traces", "/v1/logs"].includes(request.url ?? "")) {
      request.resume(); response.writeHead(404).end(); return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBodyBytes && request.url === "/v1/traces") chunks.push(chunk);
      else chunks.length = 0;
    });
    request.on("error", () => response.destroy());
    request.on("end", () => {
      if (bytes > maxBodyBytes) { response.writeHead(413).end(); return; }
      if (request.url === "/v1/logs") { response.writeHead(200).end("{}"); return; }
      try {
        const batch = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const exportSpans: Record<string, unknown>[] = [];
        for (const resource of Array.isArray(batch.resourceSpans) ? batch.resourceSpans : []) {
          for (const scope of Array.isArray(object(resource).scopeSpans) ? object(resource).scopeSpans as unknown[] : []) {
            for (const value of Array.isArray(object(scope).spans) ? object(scope).spans as unknown[] : []) {
              const row = object(value);
              const name = typeof row.name === "string" && Object.hasOwn(phases, row.name) ? phases[row.name] : undefined;
              if (!name) continue;
              const startedAtMs = Number(row.startTimeUnixNano) / 1e6;
              const endedAtMs = Number(row.endTimeUnixNano) / 1e6;
              const now = Date.now();
              if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || startedAtMs < now - 86400000
                || endedAtMs < startedAtMs || endedAtMs > now + 1000) continue;
              const identity = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) && !/^0+$/.test(value);
              if (destination && identity(row.traceId, 32) && identity(row.spanId, 16)
                && typeof row.startTimeUnixNano === "string" && /^\d{16,22}$/.test(row.startTimeUnixNano)
                && typeof row.endTimeUnixNano === "string" && /^\d{16,22}$/.test(row.endTimeUnixNano)
                && (row.parentSpanId === undefined || row.parentSpanId === "" || identity(row.parentSpanId, 16))) {
                if (exportSpans.length < MAX_PROVIDER_PERFORMANCE_SPANS) exportSpans.push({ traceId: row.traceId, spanId: row.spanId,
                  ...(row.parentSpanId ? { parentSpanId: row.parentSpanId } : {}), name: row.name,
                  startTimeUnixNano: String(row.startTimeUnixNano), endTimeUnixNano: String(row.endTimeUnixNano),
                  status: { code: [0, 1, 2].includes(Number(object(row.status).code)) ? Number(object(row.status).code) : 0 } });
                else report("batch_limit");
              }
              if (collectPerformance && spans.length < MAX_PROVIDER_PERFORMANCE_SPANS && (counts.get(name) ?? 0) < 16) {
                spans.push({name, startedAtMs, endedAtMs, outcome: object(row.status).code === 2 ? "failed" : "ok"});
                counts.set(name, (counts.get(name) ?? 0) + 1);
              }
            }
          }
        }
        if (destination && exportSpans.length && pending.size < 2) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1000); timer.unref();
          const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: destination.attributes }, scopeSpans: [{ spans: exportSpans }] }] });
          const operation = fetch(destination.endpoint, { method: "POST", headers: { ...destination.headers, "Content-Type": "application/json" },
            body, signal: controller.signal, redirect: "error" }).then(response => { if (!response.ok) report("destination"); return response.body?.cancel(); }).catch(() => report("destination")).finally(() => { clearTimeout(timer); pending.delete(operation); });
          pending.set(operation, controller);
        } else if (destination && exportSpans.length) report("capacity");
        response.writeHead(200, {"Content-Type":"application/json"}).end("{}");
      } catch { response.writeHead(400).end(); }
    });
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  server.maxConnections = 2;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("OpenCode diagnostics did not bind loopback"); }
  return {
    environment: {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      // OpenCode's Effect logger reads literal values; its trace exporter receives the same map.
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
      OTEL_BSP_SCHEDULE_DELAY: "100",
    },
    take(sinceMs = 0): {code: string; spans: ProviderPerformanceSpan[]} | null {
      const collected = spans.splice(0).filter(span => span.startedAtMs >= sinceMs);
      counts.clear();
      return collected.length ? {code: PROVIDER_PERFORMANCE_DIAGNOSTIC, spans: collected} : null;
    },
    async close() {
      closed = true;
      spans.length = 0;
      for (const controller of pending.values()) controller.abort();
      await Promise.allSettled(pending.keys());
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

function openCodeTraceDestination(environment: NodeJS.ProcessEnv | undefined) {
  const endpoint = environment?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search
    || !url.pathname.endsWith("/v1/traces")) throw new Error("Invalid OpenCode trace destination");
  const headers: Record<string, string> = {};
  for (const item of (environment?.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? "").split(",").filter(Boolean)) {
    const split = item.indexOf("="); const name = item.slice(0, split); const value = decodeURIComponent(item.slice(split + 1));
    if (split < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error("Invalid OpenCode trace headers");
    headers[name] = value;
  }
  new Headers(headers);
  const attributes = [{ key: "service.name", value: { stringValue: "opencode" } }];
  const required = new Set(["paperclip.company.id", "paperclip.agent.id", "paperclip.observability.revision"]);
  for (const entry of (environment?.OTEL_RESOURCE_ATTRIBUTES ?? "").split(",")) {
    const split = entry.indexOf("="); const key = entry.slice(0, split); const value = decodeURIComponent(entry.slice(split + 1));
    if (!required.delete(key) || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) throw new Error("Invalid OpenCode trace attribution");
    attributes.push({ key, value: { stringValue: value } });
  }
  if (required.size) throw new Error("Missing OpenCode trace attribution");
  return { endpoint, headers, attributes };
}
