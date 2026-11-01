import { fork } from "node:child_process";
import type { Server as HttpServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMaintenancePostgresProxy } from "./postgres-proxy.js";
import { createMaintenanceArtifacts } from "./environment.js";

async function withDeadline<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => { throw new Error(message()); })]);
  } finally { controller.abort(); }
}

export async function withMaintenanceProvider<T>(provider: HttpServer, run: (origin: string) => Promise<T>): Promise<T> {
  let failure: { error: unknown } | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => { provider.off("error", reject); resolve(); });
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Maintenance provider failed to bind");
    return await run(`http://127.0.0.1:${address.port}`);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      const closing = provider.listening ? new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      provider.closeAllConnections();
      await closing;
    } catch (error) {
      if (failure) throw new AggregateError([failure.error, error], "Maintenance provider work and cleanup failed");
      throw error;
    }
  }
}

type Snapshot = { idle: { active: number; generation: number }; startup: { phase: string }; outgoingHttpRequests: number; network: { nonDatabaseConnections: number; databaseConnections: number; nonDatabaseBytesWritten: number }; now: number };

export async function startMaintenanceServer(databaseUrl: string, options: { artifactRoot?: string; enabled?: boolean; clock?: boolean; suppressed?: boolean; githubOrigin?: string; connector?: { origin: string; signPrivateKey: string; sealPrivateKey: string }; cloud?: { jwks: string; s3Origin: string; standby: boolean } } = {}) {
  const artifacts = await createMaintenanceArtifacts(options.artifactRoot);
  const { directory, retainedDirectory } = artifacts;
  const reservation = createServer();
  let stopProxy = async () => {};
  let stopChild = async () => {};
  let stopLog = async () => {};
  let stopping: Promise<void> | undefined;
  function stop() {
    return stopping ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [stopChild, stopProxy,
        async () => { if (reservation.listening) await new Promise<void>(resolve => reservation.close(() => resolve())); },
        stopLog, artifacts.dispose]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Maintenance cleanup failed");
    })();
  }
  try {
    const proxy = await startMaintenancePostgresProxy(databaseUrl);
    stopProxy = proxy.stop;
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Maintenance HTTP reservation failed");
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
      database: { mode: "postgres", connectionString: proxy.url, backup: { enabled: false, dir: path.join(directory, "backups") } },
      logging: { mode: "file", logDir: path.join(directory, "logs") },
      server: { deploymentMode: "local_trusted", exposure: "private", bind: "loopback", host: "127.0.0.1", port: address.port, serveUi: false },
      storage: options.cloud ? { provider: "s3", s3: { bucket: "maintenance-test", region: "us-east-1", endpoint: options.cloud.s3Origin, forcePathStyle: true } }
        : { provider: "local_disk", localDisk: { baseDir: path.join(directory, "storage") } },
      secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(directory, "master.key") } },
      telemetry: { enabled: false }, updates: { checkEnabled: false },
    }), { mode: 0o600 });
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const child = fork(fileURLToPath(new URL("./server-child.ts", import.meta.url)), [], {
      cwd: fileURLToPath(new URL("../../../../..", import.meta.url)),
      execArgv: ["--import", fileURLToPath(new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url))],
      env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "production",
        PAPERCLIP_HOME: directory, PAPERCLIP_CONFIG: configPath, PAPERCLIP_INSTANCE_ID: "maintenance-test",
        PAPERCLIP_RUNNER_STATE_DIR: path.join(directory, "durable-sessions"),
        DATABASE_URL: proxy.url, DATABASE_POOL_MAX: "6", DATABASE_APPLICATION_NAME: "maintenance-integration-test",
        PAPERCLIP_AGENT_JWT_SECRET: randomUUID(), PAPERCLIP_DECISION_SIGNING_SECRET: randomUUID(),
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomUUID(), BETTER_AUTH_SECRET: randomUUID(),
        CODEX_HOME: path.join(directory, "codex"), PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
        PAPERCLIP_DB_BACKUP_ENABLED: "false", PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
        HEARTBEAT_SCHEDULER_ENABLED: String(options.enabled ?? true),
        PAPERCLIP_MAINTENANCE_FAKE_CLOCK: String(options.clock ?? false),
        ...(options.suppressed ? { PAPERCLIP_IN_WORKTREE: "true" } : {}),
        ...(options.githubOrigin ? { PAPERCLIP_MAINTENANCE_GITHUB_ORIGIN: options.githubOrigin } : {}),
        ...(options.connector ? {
          PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID: "maintenance-connector", PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "test",
          PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: options.connector.signPrivateKey,
          PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: options.connector.sealPrivateKey,
          PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: options.connector.origin,
        } : {}),
        ...(options.cloud ? {
          PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "2026.720.0", features: {}, plugins: { autoInstall: [] } }),
          PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("hex"),
          PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "maintenance-tenant-token", PAPERCLIP_CLOUD_STACK_ID: "maintenance-stack",
          PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: options.cloud.jwks, PAPERCLIP_CLOUD_WARM_STANDBY: options.cloud.standby ? "1" : "0",
          PAPERCLIP_PUBLIC_URL: "https://pool-maintenance.staging.paperclip.app", PAPERCLIP_PRIMARY_HOST: "pool-maintenance.staging.paperclip.app",
          AWS_ACCESS_KEY_ID: "maintenance-fixture", AWS_SECRET_ACCESS_KEY: "maintenance-fixture", AWS_EC2_METADATA_DISABLED: "true",
        } : {}),
        PAPERCLIP_MIGRATION_PROMPT: "never", PAPERCLIP_MIGRATION_AUTO_APPLY: "true", PAPERCLIP_MANAGED_RUNTIME_HTTPS: "off",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "", requestId = 0;
    const log = createWriteStream(path.join(directory, "server.log"));
    stopLog = () => new Promise<void>(resolve => log.end(resolve));
    let serverReady = false;
    child.stdout?.on("data", chunk => { output += String(chunk); log.write(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); log.write(chunk); });
    const requests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let readyResolve: (port: number) => void, readyReject: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.on("message", (message: any) => {
      if (message.kind === "ready") { serverReady = true; readyResolve(message.port); }
      else if (message.id) {
        const request = requests.get(message.id); requests.delete(message.id);
        if (message.kind === "error") request?.reject(new Error(message.error)); else request?.resolve(message);
      } else if (message.kind === "error") readyReject(new Error(message.error));
    });
    child.once("error", error => readyReject(error));
    child.once("exit", (code, signal) => {
      const error = new Error(`Maintenance child exited (${code}/${signal}): ${output.slice(-12_000)}`);
      readyReject(error);
      for (const request of requests.values()) request.reject(error);
      requests.clear();
    });
    async function request<T>(command: string, payload: { ms?: number; issueUpdate?: { id: string; status: "done" }; orphanLease?: { companyId: string }; publication?: { companyId: string; scopeDigest: string; backupRoot: string; pendingRoot: string } } = {}): Promise<T> {
      const id = ++requestId;
      const result = new Promise<T>((resolve, reject) => requests.set(id, { resolve, reject }));
      child.send({ id, command, ...payload });
      try { return await withDeadline(result, 30_000, () => `Maintenance child ${command} timed out: ${output.slice(-8_000)}`); }
      finally { requests.delete(id); }
    }
    stopChild = async () => {
      try {
        if (!serverReady && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        else if (child.exitCode === null && child.signalCode === null && child.connected) await request("shutdown");
        await withDeadline(exited, 30_000, () => "Maintenance child did not exit after shutdown");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await withDeadline(exited, 5_000, () => "Maintenance child did not exit after cancellation");
        }
      }
    };
    const port = await withDeadline(ready, 90_000, () => `Maintenance boot timed out: ${output.slice(-12_000)}`);
    return {
      proxy, directory, retainedDirectory, port, stop,
      async api<T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
        if (options.clock) await request("realtime");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, signal: AbortSignal.timeout(30_000),
            headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          const value = await response.json();
          if (!response.ok) throw new Error(`Maintenance API ${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
          return value as T;
        } finally { if (options.clock) await request("freeze"); }
      },
      async createOrphanLease(companyId: string) {
        if (options.clock) await request("realtime");
        try { return await request<{ leaseId: string }>("createOrphanLease", { orphanLease: { companyId } }); }
        finally { if (options.clock) await request("freeze"); }
      },
      async updateIssue(issueUpdate: { id: string; status: "done" }) {
        if (options.clock) await request("realtime");
        try { return await request("updateIssue", { issueUpdate }); }
        finally { if (options.clock) await request("freeze"); }
      },
      publishBackup: (publication: { companyId: string; scopeDigest: string; backupRoot: string; pendingRoot: string }) => request("publishBackup", { publication }),
      snapshot: () => request<Snapshot>("snapshot"),
      drain: () => request<Snapshot>("drain"), resume: () => request<Snapshot>("resume"),
      realtime: () => request<Snapshot>("realtime"),
      async advance(ms: number) {
        const deadline = performance.now() + 30_000;
        while (proxy.starting > 0) {
          if (proxy.errors.length) throw new AggregateError(proxy.errors, "PostgreSQL observer failed");
          if (performance.now() >= deadline) throw new Error("Maintenance database startup did not finish before clock advance");
          await delay(5);
        }
        if (proxy.errors.length) throw new AggregateError(proxy.errors, "PostgreSQL observer failed");
        return request<Snapshot>("advance", { ms });
      },
      freeze: () => request<Snapshot>("freeze"),
      get output() { return output; },
      async settled(quietMs = 500, deferredStartupHolds = 0) {
        let previous = -1, quietSince = Date.now();
        for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
          const snapshot = await request<Snapshot>("snapshot");
          if (proxy.errors.length) throw new AggregateError(proxy.errors, "PostgreSQL observer failed");
          if (snapshot.idle.active !== deferredStartupHolds || proxy.pending !== 0 || proxy.queries.length !== previous) quietSince = Date.now();
          previous = proxy.queries.length;
          if (snapshot.idle.active === deferredStartupHolds && proxy.pending === 0 && Date.now() - quietSince >= quietMs) return snapshot;
          await delay(25);
        }
        throw new Error(`Maintenance did not settle: ${JSON.stringify({ queries: proxy.queries.length, pending: proxy.pending, snapshot: await request("snapshot") })}\n${output.slice(-12_000)}`);
      },
    };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Maintenance startup and cleanup failed"); }
    throw error;
  }
}
