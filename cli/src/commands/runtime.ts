import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

/** Resolve the installed public dependency without importing or starting it. */
export async function resolveCursorProvisioner(serverUrl: string): Promise<string> {
  const url = new URL(serverUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Cursor setup requires an installed Paperclip server");
  const entry = await realpath(fileURLToPath(url));
  if (!entry.endsWith("/dist/index.js")) throw new Error("Cursor setup requires the published server layout");
  const root = resolve(dirname(entry), "..");
  const manifest = join(root, "package.json");
  const info = await lstat(manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || JSON.parse(await readFile(manifest, "utf8")).name !== "@paperclipai/server") throw new Error("Cursor setup server package identity is invalid");
  const provisioner = join(root, "dist/vendor/paperclip-runner/cli/provision-cursor.cjs");
  if (await realpath(provisioner) !== provisioner || !(await lstat(provisioner)).isFile()) throw new Error("Cursor setup entrypoint escapes its server package");
  return provisioner;
}

export async function setupCursorRuntime(): Promise<void> {
  const provisioner = await resolveCursorProvisioner(import.meta.resolve("@paperclipai/server"));
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
        else if (code !== 0 || signal) reject(new Error("Cursor setup did not finish. Review its error; an invalid installation is never replaced automatically."));
        else accept();
      });
    });
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

export function registerRuntimeCommands(program: Command): void {
  program.command("runtime").description("Manage explicitly installed agent runtimes")
    .command("setup <provider>")
    .description("Install and verify the pinned Cursor runtime for this host (public downloads; no model calls)")
    .action(async (provider: string) => {
      if (provider !== "cursor") throw new Error("Supported runtime setup: paperclipai runtime setup cursor");
      await setupCursorRuntime();
    });
}
