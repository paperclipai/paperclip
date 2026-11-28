import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

const previousAdmin = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
delete process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
let supported = false;
try { supported = process.platform !== "win32" && (await getEmbeddedPostgresTestSupport()).supported; }
finally {
  if (previousAdmin !== undefined) process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = previousAdmin;
}
const execute = promisify(execFile);

it.skipIf(!supported).each(["SIGTERM", "SIGINT"] as const)("drains the test command's descendants before PostgreSQL on %s", async (signal) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-command-cancel-"));
  const ready = path.join(directory, "ready"), done = path.join(directory, "done");
  const env: NodeJS.ProcessEnv = {
    ...process.env, TEST_COMMAND_TREE_READY: ready, TEST_COMMAND_TREE_DONE: done,
    TMPDIR: directory, TEMP: directory, TMP: directory,
  };
  delete env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
  delete env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
  const wrapper = spawn(process.execPath, [
    "--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./test-postgres-command.ts", import.meta.url)), "--", process.execPath,
    fileURLToPath(new URL("./__fixtures__/test-command-tree.mjs", import.meta.url)), "root",
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  wrapper.stdout.on("data", (data) => { output = (output + String(data)).slice(-8000); });
  wrapper.stderr.on("data", (data) => { output = (output + String(data)).slice(-8000); });
  const exited = new Promise<number | null>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("exit", (code) => resolve(code));
  });
  try {
    for (let i = 0; i < 1200 && !fs.existsSync(ready) && wrapper.exitCode === null; i++) await setTimeout(25);
    expect(fs.existsSync(ready), output).toBe(true);
    const descendants = JSON.parse(fs.readFileSync(ready, "utf8")) as { root: number; grandchild: number };
    wrapper.kill(signal);
    expect(await exited, output).toBe(signal === "SIGINT" ? 130 : 143);
    expect(fs.readFileSync(done, "utf8")).toBe("database available during child shutdown");
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("paperclip-test-command-"))).toEqual([]);
    for (const pid of Object.values(descendants)) {
      const result = await execute("/bin/ps", ["-p", String(pid), "-o", "stat="]).catch(() => ({ stdout: "" }));
      expect(result.stdout.trim() === "" || result.stdout.trim().startsWith("Z"), `descendant ${pid} still running`).toBe(true);
    }
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) { wrapper.kill("SIGTERM"); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
