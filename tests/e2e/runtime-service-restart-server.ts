import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const home = process.env.PAPERCLIP_HOME;
const configPath = process.env.PAPERCLIP_CONFIG;
const port = Number(process.env.PORT);
if (process.env.NODE_ENV !== "test" || process.env.PAPERCLIP_INSTANCE_ID !== "playwright-e2e" || !home
  || !path.basename(home).startsWith("paperclip-e2e-home-") || !Number.isInteger(port) || port < 1024
  || configPath !== path.join(home, "instances", "playwright-e2e", "config.json")) {
  throw new Error("Server restart acceptance requires its dedicated throwaway instance");
}

if (process.argv.includes("--resume")) {
  // Restart the same application, database and home without onboarding again,
  // choosing a new database port, or reseeding any runtime-service rows.
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (config.database?.mode !== "embedded-postgres" || config.server?.port !== port) throw new Error("The restart fixture configuration changed");
  const { runCommand } = await import("../../cli/src/commands/run.js");
  await runCommand({ config: configPath, yes: true, repair: true });
} else {
  const socketPath = path.join(home, "restart.sock");
  const loader = path.resolve("cli/node_modules/tsx/dist/loader.mjs");
  let child: ChildProcess | null = null;
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let initialized = false, stopping = false, busy = false, finished = false;
  const lifecycle: Array<Record<string, unknown>> = [];
  console.log(`Restart fixture home: ${home}`);
  function launch() {
    if (child && child.exitCode === null && child.signalCode === null) return child.pid!;
    const script = initialized ? ["tests/e2e/runtime-service-restart-server.ts", "--resume"] : ["tests/e2e/runtime-services-server.ts"];
    child = spawn(process.execPath, ["--import", loader, ...script], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    const started = child;
    exit = new Promise((resolve, reject) => {
      started.once("error", reject);
      started.once("exit", (code, signal) => resolve({ code, signal }));
    });
    lifecycle.push({ event: "started", pid: started.pid, resumed: initialized, at: new Date().toISOString() });
    initialized = true;
    return started.pid!;
  }
  async function stopChild(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (!child) return null;
    const old = child;
    if (old.exitCode === null && old.signalCode === null) old.kill(signal);
    // Only this fixture's direct child can be signalled. Never kill its process
    // group: managed service supervision must prove it outlives the application.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([exit!, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Application did not finish graceful shutdown")), 30_000); })]);
      lifecycle.push({ event: "exited", pid: old.pid, requestedSignal: signal, ...result, at: new Date().toISOString() });
      child = null; exit = null;
      return { pid: old.pid, ...result };
    } finally { clearTimeout(timer); }
  }
  async function ready() {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error("Restarted application exited before becoming healthy");
      if (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then((response) => response.ok, () => false)) return;
      await delay(250);
    }
    throw new Error("Restarted application never became healthy");
  }
  // A mode-0600 Unix socket under mkdtemp's private directory keeps the test
  // control channel out of the application API and off all network interfaces.
  const control = net.createServer((socket) => {
    let input = "", dispatched = false;
    socket.setEncoding("utf8"); socket.setTimeout(65_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      if (dispatched || !input.includes("\n")) return;
      dispatched = true;
      void (async () => {
        if (busy || stopping) throw new Error("Fixture control is busy");
        const command = JSON.parse(input.trim()).command;
        if (!["stop", "crash", "start", "status", "finish"].includes(command)) throw new Error("Unknown fixture command");
        if (finished && command !== "finish") throw new Error("Fixture is finished");
        busy = true;
        try {
          if (command === "finish") return await finish();
          if (command === "stop" || command === "crash") return { state: "stopped", previous: await stopChild(command === "crash" ? "SIGKILL" : "SIGTERM") };
          if (command === "start") { const pid = launch(); await ready(); return { state: "ready", pid }; }
          return { state: child && child.exitCode === null && child.signalCode === null ? "running" : "stopped", pid: child?.pid ?? null };
        } finally { busy = false; }
      })().then((result) => socket.end(JSON.stringify(result) + "\n"), (error) => socket.end(JSON.stringify({ error: String(error.message) }) + "\n"));
    });
  });
  await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  launch();
  async function finish() {
    if (finished) return { state: "finished" };
    await stopChild();
    // Finish before Playwright signals the fixture's process group. This avoids
    // racing that signal against verification of the surviving database.
    const expectedData = path.join(home!, "instances", "playwright-e2e", "db");
    const config = JSON.parse(await fs.readFile(configPath!, "utf8"));
    if (config.database?.embeddedPostgresDataDir && await fs.realpath(config.database.embeddedPostgresDataDir) !== await fs.realpath(expectedData)) throw new Error("Refusing cleanup outside the fixture database");
    const { stopEmbeddedPostgresIfRunning } = await import("../../server/src/services/workspace-instance-cleanup.js");
    const databaseStopped = await stopEmbeddedPostgresIfRunning(expectedData);
    lifecycle.push({ event: "teardown", reusedDatabaseStopped: databaseStopped, databasePort: config.database.embeddedPostgresPort, at: new Date().toISOString() });
    await fs.writeFile(path.join(home!, "restart-fixture-lifecycle.json"), JSON.stringify(lifecycle, null, 2));
    finished = true;
    return { state: "finished", reusedDatabaseStopped: databaseStopped };
  }
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      while (busy) await delay(100);
      await finish();
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  }
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}
