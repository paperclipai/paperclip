/** Throwaway acceptance instance: real app, DB, queues and publications.
 * The execution provider is synthetic. Speko is live unless SPEKO_NATIVE_STUB=1.
 * Run with server/node_modules/.bin/tsx tests/speko-native/server.ts.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";

const home = await mkdtemp(resolve(tmpdir(), "paperclip-speko-native-"));
const port = Number(process.env.SPEKO_NATIVE_PORT ?? 3449);
const origin = `http://127.0.0.1:${port}`;
const callbackOrigin = process.env.SPEKO_NATIVE_CALLBACK_ORIGIN;
if (!callbackOrigin || new URL(callbackOrigin).protocol !== "https:") throw new Error("Explicit HTTPS callback origin required");
// Set isolation before importing anything that reads Paperclip configuration.
Object.assign(process.env, {
  NODE_ENV: "test", PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "speko-native-acceptance",
  PAPERCLIP_CONFIG: resolve(home, "config.json"), PAPERCLIP_DISABLE_CWD_ENV_FILE: "true",
  PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"),
  PAPERCLIP_DECISION_SIGNING_SECRET: randomBytes(32).toString("hex"),
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomBytes(32).toString("hex"),
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: resolve(home, "master.key"),
  PAPERCLIP_API_URL: origin, PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL: callbackOrigin,
  PAPERCLIP_DEPLOYMENT_MODE: process.env.SPEKO_NATIVE_AUTH === "1" ? "authenticated" : "local_trusted",
  PAPERCLIP_AUTH_PUBLIC_BASE_URL: origin, PAPERCLIP_AUTH_BASE_URL_MODE: "explicit", PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
  PAPERCLIP_VITE_CACHE_DIR: resolve(home, "vite-cache"), PAPERCLIP_OPEN_ON_LISTEN: "false",
  PAPERCLIP_TELEMETRY_ENABLED: "false",
});
delete process.env.DATABASE_URL;
delete process.env.PAPERCLIP_IN_WORKTREE;
delete process.env.PAPERCLIP_MANAGED_CONFIG;
await mkdir(resolve(home, "storage"));
const { startEmbeddedPostgresTestDatabase, applyPendingMigrations } = await import("../../packages/db/src/index.js");
const database = await startEmbeddedPostgresTestDatabase("paperclip-speko-native-db-");
const { spawn } = await import("node:child_process");
// The supervisor owns the temporary database. Restarting app code preserves
// calls, credentials and delivery receipts so recovery can be qualified.
const spawnApp = () => spawn("server/node_modules/.bin/tsx", [...(process.env.SPEKO_NATIVE_WATCH === "0" ? [] : ["watch"]), "tests/speko-native/app.ts"], {
  cwd: resolve(import.meta.dirname, "../.."), stdio: "inherit",
  env: { ...process.env, DATABASE_URL: database.connectionString },
});
let child = spawnApp();
let stopping = false, restarting = false;
function watchExit() {
  child.once("exit", () => {
    if (stopping || restarting) return;
    if (process.env.SPEKO_NATIVE_PERSIST === "1") { console.error("Live test application stopped; database retained. SIGUSR2 restarts the app."); return; }
    void database.cleanup().then(() => process.exit(1));
  });
}
watchExit();
await writeFile(resolve(home, "instance.json"), JSON.stringify({ origin, callbackOrigin, startedAt: new Date().toISOString(), pid: process.pid }), { mode: 0o600 });
if (process.env.SPEKO_NATIVE_INSTANCE_FILE) await writeFile(process.env.SPEKO_NATIVE_INSTANCE_FILE, JSON.stringify({ home, origin, callbackOrigin, supervisorPid: process.pid }), { mode: 0o600 });
async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
// Only explicitly isolated fixture instances accept this restart signal.
if ((process.env.SPEKO_NATIVE_STUB === "1" || process.env.SPEKO_NATIVE_PERSIST === "1") && process.env.SPEKO_NATIVE_WATCH === "0") {
  process.on("SIGUSR2", () => {
    if (stopping || restarting) return;
    restarting = true;
    void stopChild().then(async () => {
      await applyPendingMigrations(database.connectionString);
      if (!stopping) { child = spawnApp(); watchExit(); }
      restarting = false;
    }).catch(error => {
      restarting = false;
      if (process.env.SPEKO_NATIVE_PERSIST === "1") console.error("Live fixture restart failed; database retained:", error.message);
      else void stop();
    });
  });
}
async function stop() {
  if (stopping) return; stopping = true;
  await stopChild();
  await database.cleanup();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
