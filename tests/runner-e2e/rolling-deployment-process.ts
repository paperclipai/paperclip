import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
import { prepareRunnerE2EServerConfig } from "./server-config.js";
import { createRunnerE2EServerStopper } from "./server-stop.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

export async function startRollingDeploymentProcess(input: {
  root: string;
  name: string;
  repositoryRoot: string;
  databaseUrl: string;
  ingressOrigin: string;
  sharedEnvironment: NodeJS.ProcessEnv;
  browser?: { omitAssets?: string[] };
}) {
  const home = path.join(input.root, input.name);
  const temporary = path.join(home, "tmp");
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const port = await reserveRunnerE2EServerPort();
  const configPath = path.join(home, "instances/default/config.json");
  const reservation = await prepareRunnerE2EServerConfig({ temporaryRoot: home, configPath, serverPort: port });
  await reservation?.close();
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  config.database = { ...config.database, mode: "postgres", connectionString: input.databaseUrl };
  config.server.serveUi = Boolean(input.browser);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const log = createWriteStream(path.join(input.root, `${input.name}.log`), { mode: 0o600 });
  const spawnErrors = new WeakMap<ChildProcess, Error>();
  const stopper = createRunnerE2EServerStopper({
    gracefulTimeoutMs: 90_000, forcedTimeoutMs: 5_000,
    hasSpawnError: child => spawnErrors.has(child), markExpectedStop() {},
    log: message => log.write(message),
  });
  let entry = path.join(input.repositoryRoot, "server/src/index.ts");
  if (input.browser) {
    // Independent build directories let the browser test remove A completely
    // and omit an old lazy chunk from B without mutating the checkout's build.
    const appRoot = path.join(home, "app/server");
    await mkdir(appRoot, { recursive: true });
    await cp(path.join(input.repositoryRoot, "server/dist"), path.join(appRoot, "dist"), { recursive: true });
    await cp(path.join(input.repositoryRoot, "ui/dist"), path.join(appRoot, "ui-dist"), { recursive: true });
    await symlink(path.join(input.repositoryRoot, "server/node_modules"), path.join(appRoot, "node_modules"));
    await writeFile(path.join(appRoot, "package.json"), '{"type":"module"}');
    for (const omittedAsset of input.browser.omitAssets ?? []) {
      if (!/^[A-Za-z0-9_.-]+\.js$/.test(omittedAsset)) throw new Error("Unsafe omitted asset fixture");
      for (const suffix of ["", ".br", ".gz"]) await rm(path.join(appRoot, "ui-dist/assets", omittedAsset + suffix), { force: true });
    }
    entry = path.join(appRoot, "dist/index.js");
  }
  const child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(input.repositoryRoot, entry), {
    cwd: input.repositoryRoot,
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: temporary,
      NODE_ENV: "test", PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: configPath,
      PAPERCLIP_INSTANCE_ID: "default", DATABASE_URL: input.databaseUrl,
      PAPERCLIP_API_URL: input.ingressOrigin, PAPERCLIP_TELEMETRY_ENABLED: "false",
      PAPERCLIP_DISABLE_TELEMETRY: "true", PAPERCLIP_LOG_LEVEL: "warn",
      HEARTBEAT_SCHEDULER_ENABLED: "false", ...input.sharedEnvironment,
    },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", error => spawnErrors.set(child, error));
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  await stopper.watch(child);
  const origin = `http://127.0.0.1:${port}`;
  let stopped = false;
  return {
    child, home, origin,
    async waitForReady() {
      const started = performance.now();
      while (performance.now() - started < 180_000) {
        if (spawnErrors.has(child) || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Server ${input.name} exited before readiness; inspect ${input.name}.log`);
        }
        const health = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(2_000) })
          .then(async response => response.ok ? await response.json() as { status?: string } : null).catch(() => null);
        if (health?.status === "ready") return { elapsedMs: Math.round(performance.now() - started), pid: child.pid };
        await delay(100);
      }
      throw new Error(`Server ${input.name} did not become ready; inspect ${input.name}.log`);
    },
    async stop() {
      if (stopped) return;
      await stopper.stopAll();
      await new Promise<void>(resolve => log.end(resolve));
      stopped = true;
    },
  };
}
