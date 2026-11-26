/** Opt-in, credential-free browser smoke: teardown retains its authenticated API client. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { parseConnectionConfig } from "./connection-config.js";
import { openConnectionBrowser } from "./connection-launch.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

if (process.argv[2] === "--worker") {
  const origin = process.argv[3]!;
  const browser = await openConnectionBrowser(parseConnectionConfig({ browser: {
    headed: false, channel: "chromium", freshness: "signed-out",
  } }), repositoryRoot, origin);
  await browser.context.pages()[0]!.goto(origin);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      let ok = false;
      try { ok = (await browser.context.request.get(`${origin}/cleanup`)).ok(); }
      finally { await browser.close(); }
      process.send?.({ kind: "cleanup", ok });
      process.disconnect();
      process.exitCode = ok ? 0 : 1;
    })().catch(() => { process.exitCode = 1; process.disconnect(); });
  });
  process.send?.({ kind: "ready" });
} else {
  let cleanupRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/cleanup") {
      const authenticated = req.headers.cookie === "qa-cleanup=synthetic";
      if (authenticated) cleanupRequests++;
      res.writeHead(authenticated ? 200 : 401).end();
    } else res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "qa-cleanup=synthetic; HttpOnly; Path=/" }).end("<p>Synthetic cleanup fixture</p>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [...runnerE2ETypeScriptProcessArgs(repositoryRoot, import.meta.filename), "--worker", origin], {
          cwd: repositoryRoot, env, stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        let cleaned = false;
        const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${signal}: browser cleanup timed out`)); }, 30_000);
        child.on("message", message => {
          const event = message as { kind?: string; ok?: boolean };
          if (event.kind === "ready") child.kill(signal);
          if (event.kind === "cleanup") cleaned = event.ok === true;
        });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", code => {
          clearTimeout(timeout);
          if (code === 0 && cleaned) resolve();
          else reject(new Error(`${signal}: browser closed before authenticated fixture cleanup`));
        });
      });
      console.log(`${signal}: authenticated cleanup completed before browser close`);
    }
    if (cleanupRequests !== 3) throw new Error("Missing authenticated cleanup requests");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
