import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export interface EphemeralMigrationResult {
  counts: Record<string, number>;
  eligibility: { eligible: boolean; blockers: string[] };
  decisionSigningSecret: string;
}

/** A dedicated maintenance process, never mounted on the ordinary app router.
 * Cloud supplies a fresh attempt token and keeps tenant routing closed. Only
 * the authenticated export transfers the original key to its durable vault. */
export async function startEphemeralMigrationService(input: {
  id: string; commit: string; token: string; port: number; host?: string; timeoutMs?: number;
  migrate: (signal: AbortSignal, phase: (name: string) => void) => Promise<EphemeralMigrationResult>;
}) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.id) || !/^[a-f0-9]{40}$/i.test(input.commit)
    || !/^[A-Za-z0-9_-]{43,128}$/.test(input.token)) throw new Error("Invalid maintenance identity or credential");
  const authorization = Buffer.from(`Bearer ${input.token}`);
  const cancellation = new AbortController();
  let state: "running" | "ready" | "blocked" = "running", phase = "configuration", failure: string | undefined;
  let result: EphemeralMigrationResult | undefined;
  const startedAt = new Date().toISOString();
  let completedAt: string | undefined;
  const receipt = () => ({ schema: "paperclip.ephemeral-migration.v1", id: input.id, commit: input.commit,
    state, phase, startedAt, completedAt, failure, counts: result?.counts, eligibility: result?.eligibility });
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    const send = (code: number, body: unknown) => { response.writeHead(code); response.end(JSON.stringify(body)); };
    if (request.method === "GET" && request.url === "/health") return send(200, { status: "maintenance" });
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) return send(401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/status") return send(200, receipt());
    if (request.method === "POST" && request.url === "/export") {
      if (state !== "ready" || !result) return send(409, receipt());
      return send(200, { ...receipt(), decisionSigningSecret: result.decisionSigningSecret });
    }
    send(404, { error: "not_found" });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
  cancellation.signal.addEventListener("abort", () => {
    state = "blocked";
    failure = cancellation.signal.reason instanceof Error ? cancellation.signal.reason.message : "maintenance_stopped";
    completedAt = new Date().toISOString();
  }, { once: true });
  const deadline = setTimeout(() => cancellation.abort(new Error("maintenance_deadline_exceeded")), input.timeoutMs ?? 25 * 60_000);
  const finished = (async () => {
    try {
      const migrated = await input.migrate(cancellation.signal, next => { phase = next; });
      cancellation.signal.throwIfAborted();
      if (!migrated.eligibility.eligible || migrated.decisionSigningSecret.trim().length < 32) throw new Error("incomplete_migration_receipt");
      result = migrated; state = "ready";
    } catch (error) {
      // Owner codes are safe diagnostics. Never echo arbitrary SDK errors,
      // credential-bearing URLs, file contents or stack traces through HTTP.
      const code = error instanceof Error ? error.message : "owner_migration_failed";
      failure = /^[a-z_]{1,80}$/.test(code) ? code : "owner_migration_failed";
      state = "blocked";
    } finally {
      // Successful export authority expires at the original deadline too.
      // A failed migration has no export authority to retain.
      if (state !== "ready") clearTimeout(deadline);
      completedAt = new Date().toISOString();
    }
  })();
  return { server, finished, receipt,
    async close() {
      cancellation.abort(new Error("maintenance_stopped"));
      clearTimeout(deadline);
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await finished;
    },
  };
}
