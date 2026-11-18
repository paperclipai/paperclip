import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const relativeScript = "skills/paperclip-wsl/scripts/paperclip-wsl.mjs";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const fail = (message) => { throw new Error(`Paperclip WSL preflight: ${message}`); };
const nativePath = (value) => typeof value === "string" && value.startsWith("/") && !value.startsWith("/mnt/") && !value.endsWith(".exe");

try {
  const filename = path.join(repository, ".paperclip/wsl.local.json");
  if (!fs.existsSync(filename)) fail("configure the untracked .paperclip/wsl.local.json first");
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  for (const field of ["distro", "user", "checkout", "node", "paperclipHome", "instanceId"]) {
    if (typeof config[field] !== "string" || !config[field] || /[\r\n\0]/.test(config[field])) fail(`invalid ${field}`);
  }
  for (const field of ["checkout", "node", "paperclipHome"]) if (!nativePath(config[field])) fail(`${field} must be a native Linux path`);
  if (!/^[a-zA-Z0-9_-]+$/.test(config.instanceId)) fail("invalid instance identifier");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail("invalid instance port");

  if (process.platform === "win32") {
    if (args[0] === "--linux-entry") fail("configured Linux Node resolved to a Windows executable");
    const child = spawnSync("wsl.exe", ["--distribution", config.distro, "--user", config.user,
      "--cd", config.checkout, "--exec", config.node, `${config.checkout}/${relativeScript}`, "--linux-entry", ...args], { stdio: "inherit", shell: false });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } else {
    if (process.platform !== "linux") fail("this configured workflow requires Linux");
    const commands = args[0] === "--linux-entry" ? args.slice(1) : args;
    if (fs.realpathSync(config.checkout) !== fs.realpathSync(repository)) fail("different Linux checkout selected");
    if (fs.realpathSync(process.execPath) !== fs.realpathSync(config.node) || !nativePath(fs.realpathSync(process.execPath))) fail("unexpected Node executable");
    if (os.userInfo().username !== config.user) fail("different Linux user selected");
    if (process.env.WSL_DISTRO_NAME && process.env.WSL_DISTRO_NAME !== config.distro) fail("different WSL distribution selected");
    const instance = path.join(config.paperclipHome, "instances", config.instanceId);
    for (const [key, expected] of [["PAPERCLIP_HOME", config.paperclipHome], ["PAPERCLIP_INSTANCE_ID", config.instanceId]]) {
      if (process.env[key] && process.env[key] !== expected) fail(`${key} selects another instance`);
    }
    const selectedConfig = path.join(instance, "config.json");
    if (process.env.PAPERCLIP_CONFIG && path.resolve(repository, process.env.PAPERCLIP_CONFIG) !== selectedConfig) fail("PAPERCLIP_CONFIG selects another instance");
    for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL"]) {
      if (process.env[key] !== undefined) fail(`${key} overrides the selected instance; configure its config file instead`);
    }
    if (process.env.PORT !== undefined && Number(process.env.PORT) !== config.port) fail("PORT differs from the selected instance");
    const settings = JSON.parse(fs.readFileSync(selectedConfig, "utf8"));
    if (settings.server?.port !== config.port) fail("instance port differs from the local profile");
    const dataPaths = [settings.database?.embeddedPostgresDataDir, settings.storage?.localDisk?.baseDir, settings.secrets?.localEncrypted?.keyFilePath].filter(Boolean);
    if (dataPaths.some((value) => !nativePath(value))) fail("instance still contains Windows data paths");
    const bins = config.binPaths ?? [path.dirname(config.node), "/usr/local/bin", "/usr/bin", "/bin"];
    if (!Array.isArray(bins) || bins.some((value) => !nativePath(value))) fail("tool directories must be native Linux paths");
    for (const [key, expected] of [
      ["PAPERCLIP_STORAGE_LOCAL_DIR", settings.storage?.localDisk?.baseDir],
      ["PAPERCLIP_SECRETS_MASTER_KEY_FILE", settings.secrets?.localEncrypted?.keyFilePath],
      ["PAPERCLIP_DB_BACKUP_DIR", settings.database?.backup?.dir],
    ]) if (process.env[key] !== undefined && (!expected || path.resolve(repository, process.env[key]) !== path.resolve(expected))) fail(`${key} differs from the selected instance`);
    const environment = { ...process.env, PATH: bins.join(":"), PAPERCLIP_HOME: config.paperclipHome, PAPERCLIP_INSTANCE_ID: config.instanceId, PAPERCLIP_CONFIG: selectedConfig };
    for (const key of ["CARGO_HOME", "RUSTUP_HOME"]) if (config[key]) { if (!nativePath(config[key])) fail(`invalid ${key}`); environment[key] = config[key]; }
    const capacity = fs.statfsSync(config.capacityPath ?? config.paperclipHome);
    const availableBytes = capacity.bavail * capacity.bsize;
    if (availableBytes < (config.minimumFreeBytes ?? 10 * 1024 ** 3)) fail("insufficient free host storage");
    const run = (command, parameters, stdio = "pipe") => {
      const result = spawnSync(command, parameters, { cwd: repository, env: environment, encoding: "utf8", stdio, shell: false });
      if (result.error) throw result.error;
      return result;
    };
    const gitRoot = run("git", ["rev-parse", "--show-toplevel"]);
    if (gitRoot.status !== 0 || fs.realpathSync(gitRoot.stdout.trim()) !== fs.realpathSync(repository)) fail("Git resolves another checkout");
    const resolveCommand = (command) => {
      if (!command || command.startsWith("-") || /[\r\n\0]/.test(command)) fail("invalid command");
      const resolved = run("which", [command]);
      if (resolved.status !== 0 || !nativePath(fs.realpathSync(resolved.stdout.trim()))) fail(`non-native or unavailable command: ${command}`);
    };
    resolveCommand("git"); resolveCommand("pnpm");
    if (commands[0] === "preflight") {
      const libc = run("getconf", ["GNU_LIBC_VERSION"]);
      const libcVersion = /^glibc (\d+\.\d+)$/.exec(libc.stdout?.trim() ?? "");
      const { paperclipRunnerSupportsPlatform, PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION } = await import(
        pathToFileURL(path.join(repository, "packages/shared/src/agent-runner.ts")));
      const runnerSupported = libc.status === 0 && libcVersion &&
        paperclipRunnerSupportsPlatform("codex_local", process.platform, process.arch, "glibc", libcVersion[1]);
      if (commands.includes("--runner") && !runnerSupported) fail(`Paperclip Runner requires a supported Linux platform and glibc ${PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION} or newer`);
      if (commands.includes("--health")) {
        const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok || (await response.json()).status !== "ok") fail("selected instance is not healthy");
      }
      console.log(JSON.stringify({ platform: process.platform, user: config.user, checkout: repository, node: process.execPath, instance, port: config.port, availableBytes, libc: libc.stdout?.trim(), runnerSupported: Boolean(runnerSupported) }));
    } else if (commands[0] === "exec" && commands.length > 1) {
      resolveCommand(commands[1]);
      const result = run(commands[1], commands.slice(2), "inherit"); process.exitCode = result.status ?? 1;
    } else fail("use preflight [--health] [--runner] or exec <command> [arguments]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
