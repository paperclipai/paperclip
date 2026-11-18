import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const relativeScript = "skills/paperclip-wsl/scripts/paperclip-wsl.mjs";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const fail = (message) => { throw new Error(`Paperclip WSL preflight: ${message}`); };
const nativePath = value => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.endsWith(".exe")) return false;
  let resolved = path.posix.normalize(value);
  if (process.platform === "linux") {
    let parent = resolved;
    const missing = [];
    while (!fs.existsSync(parent)) {
      if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
    resolved = path.join(fs.realpathSync(parent), ...missing);
  }
  return resolved !== "/mnt" && !resolved.startsWith("/mnt/");
};

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
      "--cd", config.checkout, "--exec", config.node, `${config.checkout}/${relativeScript}`, "--linux-entry", Buffer.from(JSON.stringify(config)).toString("base64url"), ...args], { stdio: "inherit", shell: false });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } else {
    if (process.platform !== "linux") fail("this configured workflow requires Linux");
    let commands = args;
    if (args[0] === "--linux-entry") {
      const expected = JSON.parse(Buffer.from(args[1] ?? "", "base64url").toString("utf8"));
      const fields = [...new Set([...Object.keys(config), ...Object.keys(expected)])].sort();
      if (fields.some(key => JSON.stringify(config[key]) !== JSON.stringify(expected[key]))) fail("Windows and Linux profiles differ");
      commands = args.slice(2);
    }
    if (fs.realpathSync(config.checkout) !== fs.realpathSync(repository)) fail("different Linux checkout selected");
    if (fs.realpathSync(process.execPath) !== fs.realpathSync(config.node) || !nativePath(fs.realpathSync(process.execPath))) fail("unexpected Node executable");
    if (os.userInfo().username !== config.user) fail("different Linux user selected");
    if (process.env.WSL_DISTRO_NAME && process.env.WSL_DISTRO_NAME !== config.distro) fail("different WSL distribution selected");
    const instance = path.join(config.paperclipHome, "instances", config.instanceId);
    const selectedConfig = path.join(instance, "config.json");
    const settings = JSON.parse(fs.readFileSync(selectedConfig, "utf8"));
    if (settings.server?.port !== config.port) fail("instance port differs from the local profile");
    const dataPaths = [settings.database?.embeddedPostgresDataDir, settings.storage?.localDisk?.baseDir, settings.secrets?.localEncrypted?.keyFilePath].filter(Boolean);
    if (dataPaths.some(value => !nativePath(value))) fail("instance still contains Windows data paths");
    if (settings.database?.backup?.dir) {
      const backup = settings.database.backup.dir;
      if (/^[a-z]:/i.test(backup) || backup.includes("\\") || !nativePath(path.resolve(repository, backup === "~" ? os.homedir() : backup.startsWith("~/") ? path.join(os.homedir(), backup.slice(2)) : backup))) fail("instance still contains Windows data paths");
    }
    const configuredBins = config.binPaths ?? ["/usr/local/bin", "/usr/bin", "/bin"];
    if (!Array.isArray(configuredBins) || configuredBins.some(value => !nativePath(value))) fail("tool directories must be native Linux paths");
    const bins = [...new Set([path.dirname(config.node), ...configuredBins])];
    const validateEnvironment = source => {
      for (const [key, expected] of [["PAPERCLIP_HOME", config.paperclipHome], ["PAPERCLIP_INSTANCE_ID", config.instanceId]]) {
        if (source[key] !== undefined && source[key] !== expected) fail(key + " selects another instance");
      }
      if (source.PAPERCLIP_CONFIG !== undefined && path.resolve(repository, source.PAPERCLIP_CONFIG) !== selectedConfig) fail("PAPERCLIP_CONFIG selects another instance");
      for (const [key, expected] of [["PAPERCLIP_CONTEXT", path.join(config.paperclipHome, "context.json")], ["PAPERCLIP_AUTH_STORE", path.join(config.paperclipHome, "auth.json")]]) {
        if (source[key] !== undefined && path.resolve(repository, source[key]) !== expected) fail(key + " selects another CLI state root");
      }
      if (source.PAPERCLIP_IN_WORKTREE === "true") fail("PAPERCLIP_IN_WORKTREE selects another scheduling context");
      for (const [key, expected] of [
        ["PAPERCLIP_STORAGE_PROVIDER", settings.storage?.provider ?? "local_disk"],
        ["PAPERCLIP_STORAGE_S3_BUCKET", settings.storage?.s3?.bucket ?? "paperclip"],
        ["PAPERCLIP_STORAGE_S3_REGION", settings.storage?.s3?.region ?? "us-east-1"],
        ["PAPERCLIP_STORAGE_S3_ENDPOINT", settings.storage?.s3?.endpoint],
        ["PAPERCLIP_STORAGE_S3_PREFIX", settings.storage?.s3?.prefix ?? ""],
        ["PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", String(settings.storage?.s3?.forcePathStyle ?? false)],
      ]) if (source[key] !== undefined && source[key] !== expected) fail(key + " selects another storage backend");
      for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL"]) {
        if (source[key] !== undefined) fail(key + " overrides the selected instance; configure its config file instead");
      }
      if (source.PORT !== undefined && Number(source.PORT) !== config.port) fail("PORT differs from the selected instance");
      for (const [key, expected] of [
        ["PAPERCLIP_STORAGE_LOCAL_DIR", settings.storage?.localDisk?.baseDir],
        ["PAPERCLIP_SECRETS_MASTER_KEY_FILE", settings.secrets?.localEncrypted?.keyFilePath],
        ["PAPERCLIP_DB_BACKUP_DIR", settings.database?.backup?.dir],
      ]) if (source[key] !== undefined && (!expected || path.resolve(repository, source[key]) !== path.resolve(expected))) fail(key + " differs from the selected instance");
    };
    validateEnvironment(process.env);
    for (const filename of [path.join(instance, ".env"), path.join(repository, ".env"), path.join(repository, "server", ".env")]) {
      if (fs.existsSync(filename)) validateEnvironment(parseEnv(fs.readFileSync(filename, "utf8")));
    }
    if (process.env.WSL_DISTRO_NAME && !config.capacityPath) fail("capacityPath must select the Windows volume that contains the WSL virtual disk");
    if (config.capacityPath !== undefined && (!config.capacityPath.startsWith("/mnt/") || !/^[a-z]$/.test(config.capacityPath.split("/")[2]))) fail("capacityPath must select a Windows host volume");
    const environment = { ...process.env, PATH: bins.join(":"), PAPERCLIP_HOME: config.paperclipHome, PAPERCLIP_INSTANCE_ID: config.instanceId, PAPERCLIP_CONFIG: selectedConfig, PAPERCLIP_DISABLE_CWD_ENV_FILE: "true", PAPERCLIP_CONTEXT: path.join(config.paperclipHome, "context.json"), PAPERCLIP_AUTH_STORE: path.join(config.paperclipHome, "auth.json") };
    for (const key of ["CARGO_HOME", "RUSTUP_HOME"]) if (config[key]) { if (!nativePath(config[key])) fail("invalid " + key); environment[key] = config[key]; }
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
    const selectedNode = run("which", ["node"]);
    if (selectedNode.status !== 0 || fs.realpathSync(selectedNode.stdout.trim()) !== fs.realpathSync(config.node)) fail("PATH selects another Node executable");
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
