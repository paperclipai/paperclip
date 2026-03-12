#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaunchEnv,
  consumeStartupFlags,
  createLaunchAttempt,
  formatStartupContextSummary,
  recordPreflightFailure,
  recordStartupFailureIfNeeded,
  resolveStartupContext,
} from "./startup-context.mjs";

const mode = process.argv[2] === "watch" ? "watch" : "dev";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const modeLabel = mode === "watch" ? "dev" : "start";
const startupFlags = consumeStartupFlags(process.argv.slice(3));
const cliArgs = startupFlags.forwarded;

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
const forwardedArgs = [];

for (const arg of cliArgs) {
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}

const startupContext = await resolveStartupContext({
  repoRoot,
  env: process.env,
  modeLabel,
  chooseStartup: startupFlags.chooseStartup,
  clearStartup: startupFlags.clearStartup,
});

console.log(formatStartupContextSummary(startupContext));

const launchAttempt = createLaunchAttempt({
  repoRoot,
  context: startupContext,
  modeLabel,
  rawArgs: startupFlags.forwarded,
});

const env = {
  ...process.env,
  // Pin every startup-sensitive path before the server process boots so the
  // API, embedded database, and doctor tooling all resolve the same instance.
  PAPERCLIP_HOME: startupContext.paperclipHome,
  PAPERCLIP_INSTANCE_ID: startupContext.instanceId,
  PAPERCLIP_CONFIG: startupContext.configPath,
  PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
  ...buildLaunchEnv(launchAttempt),
};

if (tailscaleAuth) {
  env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
  env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
  env.PAPERCLIP_AUTH_BASE_URL_MODE = "auto";
  env.HOST = "0.0.0.0";
  console.log("[paperclip] dev mode: authenticated/private (tailscale-friendly) on 0.0.0.0");
} else {
  console.log("[paperclip] dev mode: local_trusted (default)");
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function formatPendingMigrationSummary(migrations) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

async function runPnpm(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      shell: process.platform === "win32",
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBuffer += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

async function maybePreflightMigrations() {
  if (mode !== "watch") return;
  if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return;

  const status = await runPnpm(
    ["--filter", "@paperclipai/db", "exec", "tsx", "src/migration-status.ts", "--json"],
    { env },
  );
  if (status.code !== 0) {
    process.stderr.write(status.stderr || status.stdout);
    process.exit(status.code);
  }

  let payload;
  try {
    payload = JSON.parse(status.stdout.trim());
  } catch (error) {
    process.stderr.write(status.stderr || status.stdout);
    throw error;
  }

  if (payload.status !== "needsMigrations" || payload.pendingMigrations.length === 0) {
    return;
  }

  const autoApply = process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true";
  let shouldApply = autoApply;

  if (!autoApply) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(payload.pendingMigrations)}) now? (y/N): `,
          )
        ).trim().toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) return;

  const migrate = spawn(pnpmBin, ["db:migrate"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  const exit = await new Promise((resolve) => {
    migrate.on("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }
}

try {
  await maybePreflightMigrations();
} catch (error) {
  await recordPreflightFailure(launchAttempt, error);
  throw error;
}

if (mode === "watch") {
  env.PAPERCLIP_MIGRATION_PROMPT = "never";
}

const serverScript = mode === "watch" ? "dev:watch" : "dev";
const child = spawn(
  pnpmBin,
  ["--filter", "@paperclipai/server", serverScript, ...forwardedArgs],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);

child.on("error", async (error) => {
  await recordStartupFailureIfNeeded(launchAttempt, error);
});

child.on("exit", async (code, signal) => {
  if (signal) {
    await recordStartupFailureIfNeeded(
      launchAttempt,
      new Error(`Paperclip ${modeLabel} exited with signal ${signal}`),
    );
    process.kill(process.pid, signal);
    return;
  }

  if ((code ?? 0) !== 0) {
    await recordStartupFailureIfNeeded(
      launchAttempt,
      new Error(`Paperclip ${modeLabel} exited with code ${code ?? 0}`),
    );
  }

  process.exit(code ?? 0);
});
