import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

/** Resolve the installed public dependency without importing or starting it. */
async function resolveRuntimeProvisioner(serverUrl: string, provider: "cursor" | "hermes"): Promise<string> {
  const label = provider === "hermes" ? "Hermes" : "Cursor";
  const url = new URL(serverUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error(`${label} setup requires an installed Paperclip server`);
  const entry = await realpath(fileURLToPath(url));
  if (!entry.endsWith("/dist/index.js")) throw new Error(`${label} setup requires the published server layout`);
  const root = resolve(dirname(entry), "..");
  const manifest = join(root, "package.json");
  const info = await lstat(manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || JSON.parse(await readFile(manifest, "utf8")).name !== "@paperclipai/server") throw new Error(`${label} setup server package identity is invalid`);
  const provisioner = join(root, `dist/vendor/paperclip-runner/cli/provision-${provider}.cjs`);
  if (await realpath(provisioner) !== provisioner || !(await lstat(provisioner)).isFile()) throw new Error(`${label} setup entrypoint escapes its server package`);
  return provisioner;
}

export const resolveCursorProvisioner = (serverUrl: string) => resolveRuntimeProvisioner(serverUrl, "cursor");
export const resolveHermesProvisioner = (serverUrl: string) => resolveRuntimeProvisioner(serverUrl, "hermes");

async function setupRuntime(provider: "cursor" | "hermes"): Promise<void> {
  const label = provider === "hermes" ? "Hermes" : "Cursor";
  const provisioner = await resolveRuntimeProvisioner(import.meta.resolve("@paperclipai/server"), provider);
  const child = spawn(process.execPath, [provisioner], {
    stdio: "inherit", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  const cancel = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    await new Promise<void>((accept, reject) => {
      let spawnError: Error | undefined;
      child.on("error", error => { spawnError = error; });
      child.once("close", (code, signal) => {
        if (spawnError) reject(spawnError);
        else if (code !== 0 || signal) reject(new Error(`${label} setup did not finish. Review its error; an invalid installation is never replaced automatically.`));
        else accept();
      });
    });
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

export const setupCursorRuntime = () => setupRuntime("cursor");
export const setupHermesRuntime = () => setupRuntime("hermes");

export function registerRuntimeCommands(program: Command): void {
  program.command("runtime").description("Manage explicitly installed agent runtimes")
    .command("setup <provider>")
    .description("Install and verify a pinned Cursor or Hermes runtime for this host (public downloads; no model calls)")
    .action(async (provider: string) => {
      if (provider !== "cursor" && provider !== "hermes") throw new Error("Supported runtime setup: paperclipai runtime setup <cursor|hermes>");
      await setupRuntime(provider);
    });
}
