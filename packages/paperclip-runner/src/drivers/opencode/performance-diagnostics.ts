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
export async function startOpenCodePerformanceDiagnostics() {
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
        for (const resource of Array.isArray(batch.resourceSpans) ? batch.resourceSpans : []) {
          for (const scope of Array.isArray(object(resource).scopeSpans) ? object(resource).scopeSpans as unknown[] : []) {
            for (const value of Array.isArray(object(scope).spans) ? object(scope).spans as unknown[] : []) {
              const row = object(value);
              const name = typeof row.name === "string" && Object.hasOwn(phases, row.name) ? phases[row.name] : undefined;
              if (!name || spans.length >= MAX_PROVIDER_PERFORMANCE_SPANS || (counts.get(name) ?? 0) >= 16) continue;
              const startedAtMs = Number(row.startTimeUnixNano) / 1e6;
              const endedAtMs = Number(row.endTimeUnixNano) / 1e6;
              const now = Date.now();
              if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || startedAtMs < now - 86400000
                || endedAtMs < startedAtMs || endedAtMs > now + 1000) continue;
              spans.push({name, startedAtMs, endedAtMs, outcome: object(row.status).code === 2 ? "failed" : "ok"});
              counts.set(name, (counts.get(name) ?? 0) + 1);
            }
          }
        }
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
      spans.length = 0;
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
