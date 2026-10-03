import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixtures: string[] = [];
const runs: ReturnType<typeof startWrapper>[] = [];

interface FixtureEvent {
  type: string;
  pid?: number;
  port?: number;
  signals?: string[];
}

const serverSource = `
import fs from "node:fs";
import http from "node:http";
const signals = [];
let stopping = false;
const report = (event) => console.log("FIXTURE " + JSON.stringify(event));
const server = http.createServer((_req, res) => res.end("fixture"));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    signals.push(signal);
    report({ type: "stopping" });
    if (stopping) return;
    stopping = true;
    // The test releases cleanup explicitly, so a slow CI host cannot turn a
    // second-signal assertion into a race with a fixed shutdown delay.
    const timer = setInterval(() => {
      if (!fs.existsSync(new URL("../release-cleanup", import.meta.url))) return;
      clearInterval(timer);
      server.close(() => {
        report({ type: "cleaned", signals });
        process.exit(0);
      });
    }, 10);
  });
}
server.listen(0, "127.0.0.1", () => {
  report({ type: "ready", pid: process.pid, port: server.address().port });
});
`;

async function createFixture(realWatch = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dev-watch-"));
  fixtures.push(root);
  const server = path.join(root, "server");
  await fs.mkdir(path.join(server, "scripts"), { recursive: true });
  await fs.mkdir(path.join(server, "src"), { recursive: true });
  await fs.mkdir(path.join(server, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.copyFile(new URL("../../scripts/dev-watch.ts", import.meta.url), path.join(server, "scripts/dev-watch.ts"));
  await fs.copyFile(new URL("../dev-watch-ignore.ts", import.meta.url), path.join(server, "src/dev-watch-ignore.ts"));
  await fs.writeFile(path.join(server, "src/index.ts"), serverSource);
  const tsx = path.join(server, "node_modules/tsx");
  if (realWatch) {
    await fs.symlink(path.dirname(require.resolve("tsx/package.json")), tsx, "dir");
  } else {
    await fs.mkdir(tsx);
    await fs.writeFile(path.join(tsx, "package.json"), '{"exports":{"./cli":"./cli.cjs"}}');
    await fs.writeFile(path.join(tsx, "cli.cjs"), `
if (process.env.FIXTURE_EXIT_CODE) process.exit(Number(process.env.FIXTURE_EXIT_CODE));
else if (process.env.FIXTURE_EXIT_SIGNAL) process.kill(process.pid, process.env.FIXTURE_EXIT_SIGNAL);
else import("../../src/index.ts");
`);
  }
  return path.join(server, "scripts/dev-watch.ts");
}

function startWrapper(entry: string, env: NodeJS.ProcessEnv = {}, throughTsx = false) {
  const child = spawn(process.execPath, throughTsx ? [require.resolve("tsx/cli"), entry] : [entry], {
    env: { ...process.env, ...env },
    // The test owns this group so failure cleanup cannot kill another service.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: FixtureEvent[] = [];
  let output = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
    let newline: number;
    while ((newline = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (line.startsWith("FIXTURE ")) events.push(JSON.parse(line.slice(8)));
    }
  });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return {
    child, events, exited, closed, stderr: () => stderr,
    releaseCleanup: () => fs.writeFile(path.join(path.dirname(entry), "../release-cleanup"), ""),
  };
}

async function launch(options: { realWatch?: boolean; env?: NodeJS.ProcessEnv; missingCli?: boolean } = {}) {
  const entry = await createFixture(options.realWatch);
  if (options.missingCli) await fs.rm(path.join(path.dirname(entry), "../node_modules/tsx/cli.cjs"));
  const run = startWrapper(entry, options.env, options.realWatch);
  runs.push(run);
  return run;
}

async function waitForEvent(run: ReturnType<typeof startWrapper>, type: string) {
  await expect.poll(() => run.events.find((event) => event.type === type), {
    timeout: 5000,
    message: `fixture did not report ${type}`,
  }).toBeDefined();
  return run.events.find((event) => event.type === type)!;
}

async function canListen(port: number) {
  const listener = net.createServer();
  return new Promise<boolean>((resolve) => {
    listener.once("error", () => resolve(false));
    listener.listen(port, "127.0.0.1", () => listener.close(() => resolve(true)));
  });
}

afterEach(async () => {
  for (const run of runs.splice(0)) {
    if (run.child.pid) {
      try { process.kill(-run.child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await run.closed;
  }
  await Promise.all(fixtures.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// Windows does not implement POSIX process-group and signal termination semantics.
describe.skipIf(process.platform === "win32")("dev-watch lifecycle", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("lets tsx handle %s and finish server cleanup before exiting", async (signal) => {
    const run = await launch({ realWatch: true });
    const ready = await waitForEvent(run, "ready");
    run.child.kill(signal);
    await waitForEvent(run, "stopping");
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    await run.releaseCleanup();
    expect(await run.exited).toEqual({ code: 0, signal: null });
    await run.closed;
    expect(run.events.filter((event) => event.type === "cleaned")).toEqual([{ type: "cleaned", signals: [signal] }]);
    expect(await canListen(ready.port!)).toBe(true);
    expect(() => process.kill(ready.pid!, 0)).toThrow();
  });

  it("keeps the tsx second-signal force-stop behavior", async () => {
    const run = await launch({ realWatch: true });
    const ready = await waitForEvent(run, "ready");
    run.child.kill("SIGTERM");
    await waitForEvent(run, "stopping");
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    run.child.kill("SIGINT");
    expect(await run.exited).toEqual({ code: 0, signal: null });
    await run.closed;
    expect(run.events.some((event) => event.type === "cleaned")).toBe(false);
    expect(await canListen(ready.port!)).toBe(true);
  });

  it.each([0, 7])("preserves watcher exit code %s", async (code) => {
    const run = await launch({ env: { FIXTURE_EXIT_CODE: String(code) } });
    expect(await run.exited).toEqual({ code, signal: null });
  });

  it("preserves a watcher signal exit", async () => {
    const run = await launch({ env: { FIXTURE_EXIT_SIGNAL: "SIGTERM" } });
    expect(await run.exited).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("exits with failure when the watcher CLI cannot be loaded", async () => {
    const run = await launch({ missingCli: true });
    expect(await run.exited).toEqual({ code: 1, signal: null });
    expect(run.stderr()).toContain("MODULE_NOT_FOUND");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("lets tsx finish cleanup after process-group %s", async (signal) => {
    const run = await launch({ realWatch: true });
    const ready = await waitForEvent(run, "ready");
    process.kill(-run.child.pid!, signal);
    await waitForEvent(run, "stopping");
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    await run.releaseCleanup();
    expect(await run.exited).toEqual({ code: 0, signal: null });
    await run.closed;
    expect(run.events.some((event) => event.type === "cleaned")).toBe(true);
    expect(await canListen(ready.port!)).toBe(true);
  });
});
