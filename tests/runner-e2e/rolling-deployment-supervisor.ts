import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { createControllerRecoveryObserver } from "./controller-recovery-observer.js";
import { rollController, validControllerRollingDeploymentReceipt } from "./controller-rolling-deployment.js";
import { readRestartRequest } from "./server-restart-request.js";
import { startRollingDeploymentProcess } from "./rolling-deployment-process.js";
import { startRollingDeploymentProxy } from "./rolling-deployment-proxy.js";
import { runnerE2EServerControlPaths } from "./harness-env.js";

type Server = Awaited<ReturnType<typeof startRollingDeploymentProcess>>;

/** Isolated Product E2E supervisor. Shares only Postgres, S3 and generated
 * secrets. It never patches leases, checkpoints, execution or recovery state. */
export async function superviseRollingDeployment(input: {
  temporaryRoot: string; repositoryRoot: string; configPath: string; port: number;
  environment: NodeJS.ProcessEnv; executionIds: string[]; cancelled: () => boolean;
}) {
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(input.configPath, "utf8")));
  if (config.database.mode !== "postgres" || !config.database.connectionString) throw new Error("Rolling qualification requires independently owned Postgres");
  if (input.environment.PAPERCLIP_STORAGE_PROVIDER !== "s3") throw new Error("Rolling qualification requires disposable S3 storage");
  const databaseUrl = config.database.connectionString;
  const controls = runnerE2EServerControlPaths(input.temporaryRoot);
  const proxy = await startRollingDeploymentProxy(input.port);
  const servers: Server[] = [];
  const environment = { ...input.environment,
    PAPERCLIP_EPHEMERAL_SERVER: "true", PAPERCLIP_DURABLE_AGENT_FILES: "true", PAPERCLIP_SHARED_UI_ASSETS: "true",
    PAPERCLIP_DATABASE_LISTEN_URL: databaseUrl, PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
    HEARTBEAT_SCHEDULER_ENABLED: "true", RUN_LOG_S3_BUCKET: input.environment.PAPERCLIP_STORAGE_S3_BUCKET,
    RUN_LOG_S3_ENDPOINT: input.environment.PAPERCLIP_STORAGE_S3_ENDPOINT,
    RUN_LOG_S3_REGION: input.environment.PAPERCLIP_STORAGE_S3_REGION,
    RUN_LOG_S3_FORCE_PATH_STYLE: input.environment.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE,
  };
  const start = async () => {
    const server = await startRollingDeploymentProcess({ root: input.temporaryRoot, name: `controller-${servers.length + 1}`,
      repositoryRoot: input.repositoryRoot, databaseUrl, ingressOrigin: proxy.origin, sharedEnvironment: environment, browser: {} });
    servers.push(server);
    return server;
  };
  const json = async (filename: string, value: unknown) => {
    await writeFile(`${filename}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${filename}.tmp`, filename);
  };
  const api = async <T>(route: string, method = "GET", body?: object): Promise<T> => {
    const response = await fetch(`${proxy.origin}/api${route}`, { method,
      headers: { "content-type": "application/json", origin: proxy.origin },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}`);
    return await response.json() as T;
  };
  let current: Server | undefined, lastRequest: string | undefined, probeIssueId: string | undefined;
  // The read-only observer uses the production checkpoint loader in this
  // isolated supervisor process. Give it the same disposable key as A/B/C.
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = environment.PAPERCLIP_SECRETS_MASTER_KEY;
  try {
    // Keep the fixture's isolation evidence for its one generated stable secret.
    // It is outside A/B/C homes, like the independent database and object store;
    // each server receives this exact value through its environment.
    const keyPath = path.resolve(config.secrets.localEncrypted.keyFilePath);
    if (!keyPath.startsWith(`${path.resolve(input.temporaryRoot)}${path.sep}`)) throw new Error("Rolling fixture key escaped its owned root");
    await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await writeFile(keyPath, environment.PAPERCLIP_SECRETS_MASTER_KEY, { mode: 0o600, flag: "wx" });
    current = await start(); await current.waitForReady(); proxy.routeTo(current.origin);
    while (!input.cancelled()) {
      if (current.child.exitCode !== null || current.child.signalCode !== null) throw new Error("Serving rolling controller exited unexpectedly");
      const request = await readRestartRequest(controls.restartRequestPath, input.executionIds);
      if (!request || request.requestId === lastRequest) { await delay(100); continue; }
      lastRequest = request.requestId;
      if (!request.rollingDeployment) throw new Error("Rolling supervisor requires an explicit rolling deployment request");
      const previous = current;
      const observer = request.recoveryBinding ? await createControllerRecoveryObserver(previous.configPath, request.recoveryBinding) : undefined;
      let probing = false, probes: Promise<void> | undefined;
      const stats = { reads: 0, writes: 0, verifiedWrites: 0, failures: [] as string[] };
      const writes: Array<{ id: string; body: string }> = [];
      try {
        if (!probeIssueId) {
          const companyId = request.recoveryBinding?.companyId ?? (await api<{ id: string }>("/companies", "POST", { name: "Synthetic deployment probes" })).id;
          const issue = await api<{ id: string }>(`/companies/${companyId}/issues`, "POST", {
            title: "Synthetic deployment read/save probe", description: "Unassigned fixture for ordinary user saves during deployment.", status: "todo",
          });
          probeIssueId = issue.id;
        }
        const issueRoute = `/issues/${probeIssueId}`;
        probing = true;
        probes = (async () => {
          while (probing) {
            try { await api(issueRoute); stats.reads++; } catch (error) { stats.failures.push(String(error)); }
            if (stats.reads % 10 === 0 || stats.writes === 0) {
              const body = `Synthetic deployment save ${randomUUID()}`;
              try {
                const saved = await api<{ id: string }>(`${issueRoute}/comments`, "POST", { body, clientRequestId: randomUUID() });
                writes.push({ id: saved.id, body }); stats.writes++;
              } catch (error) { stats.failures.push(String(error)); }
            }
            await delay(100);
          }
        })();
        const receiptPath = path.join(controls.controlDirectory, `controller-rolling-${request.requestId}.json`);
        const receipt = await rollController({ requestId: request.requestId, previousPid: previous.child.pid!,
          start: async () => { const server = await start(); return { pid: server.child.pid, server }; },
          waitForReady: async replacement => { await replacement.server.waitForReady(); },
          switchTraffic: replacement => { current = replacement.server; proxy.routeTo(current.origin); },
          stopPrevious: () => previous.stop({ requireGraceful: true }),
          deletePreviousHome: () => rm(previous.home, { recursive: true }),
          beforeHandoff: observer?.beforeHandoff,
          afterPreviousStopped: observer?.stoppedAfterHandoff,
          afterHandoff: observer ? (receipt, record) => observer.recovered(receipt, record, input.cancelled) : undefined,
          cancelled: input.cancelled, record: value => json(receiptPath, value),
        });
        probing = false; await probes;
        const saved = await api<Array<{ id: string; body: string }>>(`${issueRoute}/comments`);
        stats.verifiedWrites = writes.filter(write => saved.filter(comment => comment.id === write.id && comment.body === write.body).length === 1).length;
        receipt.probes = stats; await json(receiptPath, receipt);
        if (!validControllerRollingDeploymentReceipt(receipt, request.requestId)) throw new Error("Rolling boundary failed overlap, empty-home, or ordinary read/save qualification");
        await json(controls.restartAcknowledgementPath, { requestId: request.requestId, status: "ready", controllerCacheDiscarded: true,
          completedAt: new Date().toISOString(), rollingDeployment: receipt });
      } catch (error) {
        await json(controls.restartAcknowledgementPath, { requestId: request.requestId, status: "failed", message: String(error) });
        throw error;
      } finally { probing = false; await probes; await observer?.close(); }
    }
  } finally {
    // Every started server remains owned, including an unready successor.
    // End-of-attempt cleanup also runs after a retained failing receipt.
    try {
      try { await Promise.all(servers.map(server => server.stop())); }
      finally { await proxy.close(); }
    } finally {
      if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
  }
}
