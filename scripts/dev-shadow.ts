#!/usr/bin/env -S node --import tsx
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createDevShadowEnv,
  parseDevShadowArgs,
  probeDevShadowDatabase,
  resolveDevShadowDatabaseUrl,
} from "./dev-shadow-core.mjs";

async function main(): Promise<void> {
  const options = parseDevShadowArgs(process.argv.slice(2));
  const databaseUrl = await resolveDevShadowDatabaseUrl(options);
  await probeDevShadowDatabase(databaseUrl);
  const env = createDevShadowEnv(options, databaseUrl);
  console.log(`[paperclip] shadow dev: ${env.PAPERCLIP_API_URL} sharing ${options.sourceApi} database`);

  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    pnpmBin,
    ["--filter", "@paperclipai/server", "exec", "tsx", "../scripts/dev-runner.ts", "watch"],
    { env, stdio: "inherit" },
  );
  child.once("error", (error) => {
    console.error(`[paperclip] failed to start shadow dev runner: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    console.error(`[paperclip] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
