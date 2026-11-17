import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { makeDirectoryTreeRemovable } from "./directory-cleanup.js";
import { runnerE2EServerControlPaths } from "./harness-env.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
import { startRollingDeploymentProcess } from "./rolling-deployment-process.js";
import { startRollingDeploymentProxy } from "./rolling-deployment-proxy.js";
import { readRestartRequest } from "./server-restart-request.js";
import { createRunnerE2EServerStopper } from "./server-stop.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

type Server = Awaited<ReturnType<typeof startRollingDeploymentProcess>>;

export async function superviseLegacyWorkspaceMigration(input: {
  temporaryRoot: string; repositoryRoot: string; configPath: string; port: number;
  environment: NodeJS.ProcessEnv; executionIds: string[]; cancelled: () => boolean;
}) {
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(input.configPath, "utf8")));
  if (input.executionIds.length !== 1 || config.database.mode !== "postgres" || !config.database.connectionString
    || input.environment.PAPERCLIP_STORAGE_PROVIDER !== "s3") throw new Error("Migration qualification requires one owned Postgres/S3 cell");
  const databaseUrl = config.database.connectionString, controls = runnerE2EServerControlPaths(input.temporaryRoot);
  const proxy = await startRollingDeploymentProxy(input.port), servers: Server[] = [];
  const environment: NodeJS.ProcessEnv = { ...input.environment,
    PAPERCLIP_DATABASE_LISTEN_URL: databaseUrl, PAPERCLIP_SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
    HEARTBEAT_SCHEDULER_ENABLED: "true", PAPERCLIP_EPHEMERAL_SERVER: "true",
    PAPERCLIP_DURABLE_AGENT_FILES: "true", PAPERCLIP_SHARED_UI_ASSETS: "true",
    RUN_LOG_S3_BUCKET: input.environment.PAPERCLIP_STORAGE_S3_BUCKET,
    RUN_LOG_S3_ENDPOINT: input.environment.PAPERCLIP_STORAGE_S3_ENDPOINT,
    RUN_LOG_S3_REGION: input.environment.PAPERCLIP_STORAGE_S3_REGION,
    RUN_LOG_S3_FORCE_PATH_STYLE: input.environment.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE };
  const start = async (name: string, env: NodeJS.ProcessEnv) => {
    const server = await startRollingDeploymentProcess({ root: input.temporaryRoot, name, repositoryRoot: input.repositoryRoot,
      databaseUrl, ingressOrigin: proxy.origin, sharedEnvironment: env, browser: {} });
    servers.push(server); return server;
  };
  const json = async (filename: string, value: unknown) => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(`${filename}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${filename}.tmp`, filename);
  };
  const settings = async (enabled: boolean) => {
    const response = await fetch(`${proxy.origin}/api/instance/settings/experimental`, { method: "PATCH",
      headers: { "content-type": "application/json", origin: proxy.origin },
      body: JSON.stringify({ remoteWorkspaceStorageEnabled: enabled, enableExperimentalFileViewer: true }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Migration fixture settings returned ${response.status}`);
    await response.body?.cancel();
  };
  let maintenance: { stop(): Promise<void> } | undefined;
  try {
    const keyPath = path.resolve(config.secrets.localEncrypted.keyFilePath);
    if (!keyPath.startsWith(`${path.resolve(input.temporaryRoot)}${path.sep}`)) throw new Error("Migration fixture key escaped its root");
    await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await writeFile(keyPath, environment.PAPERCLIP_SECRETS_MASTER_KEY!, { mode: 0o600, flag: "wx" });
    const legacyEnvironment: NodeJS.ProcessEnv = { ...environment, PAPERCLIP_EPHEMERAL_SERVER: "false", PAPERCLIP_DURABLE_AGENT_FILES: "false",
      PAPERCLIP_SHARED_UI_ASSETS: "false", PAPERCLIP_STORAGE_PROVIDER: "local_disk" };
    for (const name of Object.keys(legacyEnvironment)) if (name.startsWith("RUN_LOG_S3_")) delete legacyEnvironment[name];
    let current = await start("legacy-controller", legacyEnvironment);
    await current.waitForReady(); proxy.routeTo(current.origin); await settings(false);
    let migrated = false, lastRequest: string | undefined;
    while (!input.cancelled()) {
      if (current.child.exitCode !== null || current.child.signalCode !== null) throw new Error("Migration controller exited unexpectedly");
      const request = await readRestartRequest(controls.restartRequestPath, input.executionIds);
      if (!request || request.requestId === lastRequest) { await delay(100); continue; }
      lastRequest = request.requestId;
      try {
        if (migrated || request.rollingDeployment || request.controllerOutage || request.preserveRunner || request.crashAfterResult) {
          throw new Error("Legacy migration permits exactly one offline enrollment");
        }
        await settings(true);
        const previous = current; await previous.stop({ requireGraceful: true });
        const port = await reserveRunnerE2EServerPort(), token = randomBytes(32).toString("base64url"), id = randomUUID();
        const log = createWriteStream(path.join(input.temporaryRoot, "legacy-maintenance.log"), { mode: 0o600 });
        const errors = new WeakMap<ChildProcess, Error>();
        const stopper = createRunnerE2EServerStopper({ gracefulTimeoutMs: 15_000, forcedTimeoutMs: 5_000,
          hasSpawnError: child => errors.has(child), markExpectedStop() {}, log: message => log.write(message) });
        const child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(input.repositoryRoot,
          path.join(previous.home, "app/server/dist/maintenance/ephemeral-migration.js")), {
          cwd: input.repositoryRoot, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
          env: { ...environment, HOME: previous.home, PAPERCLIP_HOME: previous.home, PAPERCLIP_CONFIG: previous.configPath,
            PAPERCLIP_INSTANCE_ID: "default", DATABASE_URL: databaseUrl, PORT: String(port),
            PAPERCLIP_EPHEMERAL_MIGRATION: "true", PAPERCLIP_EPHEMERAL_MIGRATION_ID: id, PAPERCLIP_EPHEMERAL_MIGRATION_TOKEN: token } });
        child.on("error", error => errors.set(child, error));
        child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
        await stopper.watch(child);
        maintenance = { async stop() { await stopper.stopAll(); await new Promise<void>(resolve => log.end(resolve)); } };
        const endpoint = `http://127.0.0.1:${port}`;
        const headers = { authorization: `Bearer ${token}` };
        const deadline = Date.now() + 180_000;
        let receipt: Record<string, any> | undefined;
        while (!input.cancelled() && Date.now() < deadline) {
          if (errors.has(child) || child.exitCode !== null || child.signalCode !== null) throw new Error("Maintenance exited before a verified export");
          receipt = await fetch(`${endpoint}/status`, { headers, signal: AbortSignal.timeout(2_000) })
            .then(async response => response.ok ? await response.json() as Record<string, any> : undefined).catch(() => undefined);
          if (receipt?.state === "blocked") throw new Error(`Migration blocked: ${receipt.failure}`);
          if (receipt?.state === "ready") break;
          await delay(250);
        }
        if (receipt?.state !== "ready" || receipt.id !== id || receipt.eligibility?.eligible !== true) throw new Error("Maintenance did not qualify migration");
        const exported = await fetch(`${endpoint}/export`, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
        if (!exported.ok) throw new Error(`Migration export returned ${exported.status}`);
        const data = await exported.json() as Record<string, any>;
        if (data.id !== id || typeof data.decisionSigningSecret !== "string" || data.decisionSigningSecret.length < 32) throw new Error("Migration key export is incomplete");
        environment.PAPERCLIP_DECISION_SIGNING_SECRET = data.decisionSigningSecret;
        await json(path.join(controls.controlDirectory, "legacy-migration-receipt.json"), receipt);
        await maintenance.stop(); maintenance = undefined;
        current = await start("ephemeral-controller", environment); await current.waitForReady(); proxy.routeTo(current.origin);
        await makeDirectoryTreeRemovable(previous.home); await rm(previous.home, { recursive: true });
        migrated = true;
        await json(controls.restartAcknowledgementPath, { requestId: request.requestId, status: "ready", controllerCacheDiscarded: true,
          completedAt: new Date().toISOString(), legacyMigration: { ...receipt, oldHomeDeleted: true } });
      } catch (error) {
        await json(controls.restartAcknowledgementPath, { requestId: request.requestId, status: "failed", message: String(error) }); throw error;
      }
    }
  } finally {
    try { await maintenance?.stop(); } finally {
      try { await Promise.all(servers.map(server => server.stop())); } finally { await proxy.close(); }
    }
  }
}
