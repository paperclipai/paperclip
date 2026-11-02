import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

const configuredAdmin = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
delete process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
let embeddedSupported = false;
try { embeddedSupported = process.platform !== "win32" && (await getEmbeddedPostgresTestSupport()).supported; }
finally {
  if (configuredAdmin !== undefined) process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = configuredAdmin;
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

it.skipIf(!embeddedSupported).each(["exit", "SIGTERM"])("stops the owned PostgreSQL process when its worker receives %s", async (mode) => {
  const child = fork(fileURLToPath(new URL("./__fixtures__/test-postgres-exit.mjs", import.meta.url)), [mode], {
    execArgv: ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (data) => { output = (output + String(data)).slice(-8000); });
  child.stderr?.on("data", (data) => { output = (output + String(data)).slice(-8000); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  let server: { pid: number; dataDir: string } | undefined;
  try {
    const ready = await new Promise<{ pid: number; dataDir: string }>((resolve, reject) => {
      child.once("message", (value) => resolve(value as { pid: number; dataDir: string }));
      child.once("exit", () => reject(new Error(`Worker exited before readiness: ${output}`)));
    });
    server = ready;
    if (mode === "SIGTERM") child.kill("SIGTERM");
    expect(await exited, output).toBe(mode === "exit" ? 0 : 143);
    for (let i = 0; i < 200 && exists(ready.pid); i++) await setTimeout(25);
    expect(exists(ready.pid), output).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
    if (server && exists(server.pid)) {
      const contents = fs.readFileSync(path.join(server.dataDir, "postmaster.pid"), "utf8");
      if (Number(contents.split("\n")[0]) === server.pid) process.kill(server.pid, "SIGINT");
      for (let i = 0; i < 200 && exists(server.pid); i++) await setTimeout(25);
    }
    if (server && !exists(server.pid)) fs.rmSync(server.dataDir, { recursive: true, force: true });
  }
}, 30_000);
