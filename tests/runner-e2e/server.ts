import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  assertIsolatedServerEnvironment,
  buildPaperclipServerEnvironment,
} from "./harness-env.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const logPath = required("PAPERCLIP_RUNNER_E2E_SERVER_LOG");
const temporaryRoot = required("PAPERCLIP_RUNNER_E2E_TEMP_ROOT");
const paperclipHome = required("PAPERCLIP_HOME");
const configPath = required("PAPERCLIP_CONFIG");
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const serverEnvironment = buildPaperclipServerEnvironment(process.env, {
  NODE_ENV: "test",
  PORT: required("PAPERCLIP_RUNNER_E2E_PORT"),
  PAPERCLIP_HOME: paperclipHome,
  PAPERCLIP_CONFIG: configPath,
  PAPERCLIP_INSTANCE_ID: required("PAPERCLIP_INSTANCE_ID"),
  PAPERCLIP_AGENT_JWT_SECRET: required("PAPERCLIP_AGENT_JWT_SECRET"),
  PAPERCLIP_DECISION_SIGNING_SECRET: required(
    "PAPERCLIP_DECISION_SIGNING_SECRET",
  ),
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: required(
    "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  ),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  PAPERCLIP_BIND: "loopback",
  PAPERCLIP_BIND_HOST: "127.0.0.1",
  PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
  SERVE_UI: "true",
  PAPERCLIP_STORAGE_PROVIDER: "local_disk",
  PAPERCLIP_STORAGE_LOCAL_DIR: path.join(temporaryRoot, "storage"),
  PAPERCLIP_SECRETS_PROVIDER: "local_encrypted",
  PAPERCLIP_SECRETS_STRICT_MODE: "true",
  PAPERCLIP_DB_BACKUP_ENABLED: "false",
  PAPERCLIP_DB_BACKUP_DIR: path.join(temporaryRoot, "backups"),
  // Onboarding normally opens the app after listen. Browser ownership belongs
  // to Playwright in this harness, so never create a developer desktop tab.
  PAPERCLIP_OPEN_ON_LISTEN: "false",
});
assertIsolatedServerEnvironment(serverEnvironment, {
  temporaryRoot,
  paperclipHome,
  configPath,
});
const definedServerEnvironment = Object.fromEntries(
  Object.entries(serverEnvironment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
await mkdir(path.dirname(logPath), { recursive: true });
const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const child = spawn("pnpm", ["paperclipai", "onboard", "--yes", "--run"], {
  cwd: repositoryRoot,
  env: definedServerEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
  // Stay in the launcher-created process group. That lets the launcher stop
  // Playwright, this wrapper, Paperclip, embedded Postgres, and runner children
  // as one verified tree even if graceful web-server shutdown stalls.
  detached: false,
});

child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

function stop(signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    child.kill(signal);
  } catch {
    // The Paperclip process may already have exited.
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => stop(signal));
}

const exitCode = await new Promise<number>((resolve) => {
  child.once("error", (error) => {
    log.end(`\nserver spawn failed: ${error.message}\n`);
    resolve(1);
  });
  child.once("exit", (code, signal) => {
    log.end(`\nserver exited code=${String(code)} signal=${String(signal)}\n`);
    resolve(code ?? (signal ? 1 : 0));
  });
});
process.exitCode = exitCode;
