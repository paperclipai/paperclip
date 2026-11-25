import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command } from "commander";

/** Resolve a vendored provisioner inside the installed server, without importing it. */
async function resolveVendoredProvisioner(serverUrl: string, file: string, label: string): Promise<string> {
  const url = new URL(serverUrl);
  if (url.protocol !== "file:" || url.search || url.hash) throw new Error(`${label} setup requires an installed Paperclip server`);
  const entry = await realpath(fileURLToPath(url));
  if (!entry.endsWith("/dist/index.js")) throw new Error(`${label} setup requires the published server layout`);
  const root = resolve(dirname(entry), "..");
  const manifest = join(root, "package.json");
  const info = await lstat(manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || JSON.parse(await readFile(manifest, "utf8")).name !== "@paperclipai/server") throw new Error(`${label} setup server package identity is invalid`);
  const provisioner = join(root, "dist/vendor/paperclip-runner/cli", file);
  if (await realpath(provisioner) !== provisioner || !(await lstat(provisioner)).isFile()) throw new Error(`${label} setup entrypoint escapes its server package`);
  return provisioner;
}

/** Run a provisioner child; SIGINT/SIGTERM are forwarded and a failure rejects with `failure`. */
async function runProvisioner(args: string[], env: NodeJS.ProcessEnv, failure: string): Promise<void> {
  const child = spawn(process.execPath, args, { stdio: "inherit", env });
  const cancel = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    await new Promise<void>((accept, reject) => {
      let spawnError: Error | undefined;
      child.on("error", error => { spawnError = error; });
      child.once("close", (code, signal) => {
        if (spawnError) reject(spawnError);
        else if (code !== 0 || signal) reject(new Error(failure));
        else accept();
      });
    });
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

/** Resolve the public server dependency, without importing/starting the server. */
export function resolvePiProvisioner(serverUrl: string): Promise<string> {
  return resolveVendoredProvisioner(serverUrl, "provision-pi.cjs", "Pi");
}

export async function resolveRemoteCompanionImporter(serverUrl: string): Promise<string> {
  const provisioner = await resolvePiProvisioner(serverUrl);
  const serverRoot = resolve(dirname(provisioner), "../../../..");
  const modulePath = join(serverRoot, "dist/services/native-runtime/remote-pi-companion.js");
  if (await realpath(modulePath) !== modulePath || !(await lstat(modulePath)).isFile()) throw new Error("Remote companion importer escapes its installed server");
  return modulePath;
}

/** Public downloads may use operator network settings, never application secrets. */
export function buildPiSetupEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: source.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const key of ["LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}

export async function setupPiRuntime(): Promise<void> {
  // Only explicit setup downloads. Enable Node's proxy handling for the helper;
  // provider keys, npm configuration, HOME and Node injection remain excluded.
  await runProvisioner(["--use-env-proxy", await resolvePiProvisioner(import.meta.resolve("@paperclipai/server"))], buildPiSetupEnvironment(),
    "Pi setup did not finish. Review its error; an existing invalid installation is never replaced automatically.");
}

export function resolveCursorProvisioner(serverUrl: string): Promise<string> {
  return resolveVendoredProvisioner(serverUrl, "provision-cursor.cjs", "Cursor");
}

export async function setupCursorRuntime(): Promise<void> {
  await runProvisioner([await resolveCursorProvisioner(import.meta.resolve("@paperclipai/server"))], { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    "Cursor setup did not finish. Review its error; an invalid installation is never replaced automatically.");
}

/** Resolve Antigravity setup without importing the server or starting a provider. */
export function resolveAntigravityProvisioner(serverUrl: string): Promise<string> {
  return resolveVendoredProvisioner(serverUrl, "provision-antigravity.cjs", "Antigravity");
}

export async function setupAntigravityRuntime(): Promise<void> {
  // Setup only downloads public assets. Reuse the existing network allowlist;
  // runtime credentials and process-loader settings never reach this child.
  await runProvisioner(["--use-env-proxy", await resolveAntigravityProvisioner(import.meta.resolve("@paperclipai/server"))], buildPiSetupEnvironment(),
    "Antigravity setup did not finish. Review its error; an invalid installation is never replaced automatically.");
}

/** The experimental Antigravity CLI route (`agy`), fetched from Google at setup time. */
export function resolveAntigravityCliProvisioner(serverUrl: string): Promise<string> {
  return resolveVendoredProvisioner(serverUrl, "provision-antigravity-cli.cjs", "Antigravity CLI");
}

export async function setupAntigravityCliRuntime(): Promise<void> {
  await runProvisioner(["--use-env-proxy", await resolveAntigravityCliProvisioner(import.meta.resolve("@paperclipai/server"))], buildPiSetupEnvironment(),
    "Antigravity CLI setup did not finish. Review its error above; nothing unverified was installed.");
}

export function resolveKimiProvisioner(serverUrl: string): Promise<string> {
  return resolveVendoredProvisioner(serverUrl, "provision-kimi.cjs", "Kimi");
}

export async function setupKimiRuntime(): Promise<void> {
  await runProvisioner(["--use-env-proxy", await resolveKimiProvisioner(import.meta.resolve("@paperclipai/server"))], buildPiSetupEnvironment(),
    "Kimi setup did not finish. Review its error; an invalid installation is never replaced automatically.");
}

export function registerRuntimeCommands(program: Command): void {
  const runtime = program.command("runtime").description("Manage explicitly installed agent runtimes");
  runtime.command("import-remote <directory>")
    .description("Import a verified Linux Pi companion into the installed server (no downloads)")
    .requiredOption("--sha256 <digest>", "SHA256 of companion.json from the trusted release")
    .action(async (directory: string, options: { sha256: string }) => {
      const modulePath = await resolveRemoteCompanionImporter(import.meta.resolve("@paperclipai/server"));
      const importer = await import(pathToFileURL(modulePath).href) as { importRemotePiCompanion(input: { directory: string; sha256: string; checkCancelled: () => void }): Promise<unknown> };
      let cancelled = false;
      const cancel = () => { cancelled = true; };
      process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
      try {
        const result = await importer.importRemotePiCompanion({ directory, sha256: options.sha256,
          checkCancelled: () => { if (cancelled) throw new Error("Remote companion import cancelled"); } });
        console.log(JSON.stringify(result));
      } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    });
  runtime.command("setup <provider>")
    .description("Install and verify the pinned Pi, Cursor, Kimi Code, Antigravity, or experimental Antigravity CLI runtime for this host (public downloads; no model calls)")
    .action(async (provider: string) => {
      if (provider === "pi") await setupPiRuntime();
      else if (provider === "cursor") await setupCursorRuntime();
      else if (provider === "kimi") await setupKimiRuntime();
      else if (provider === "antigravity") await setupAntigravityRuntime();
      else if (provider === "antigravity-cli") await setupAntigravityCliRuntime();
      else throw new Error("Supported runtime setup: paperclipai runtime setup pi, cursor, kimi, antigravity, or antigravity-cli");
    });
}
