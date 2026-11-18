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
    if (!nativePath(instance)) fail("instance must be a native Linux path");
    const selectedConfig = path.join(instance, "config.json");
    const settings = JSON.parse(fs.readFileSync(selectedConfig, "utf8"));
    if ((settings.server?.port ?? 3100) !== config.port) fail("instance port differs from the local profile");
    const resolveDataPath = value => {
      if (typeof value !== 'string' || /^[a-z]:/i.test(value) || value.includes('\\')) fail('instance still contains Windows data paths');
      return path.resolve(repository, value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(),value.slice(2)) : value);
    };
    for (const [section,value] of [
      ['database',settings.database?.embeddedPostgresDataDir],
      ['storage',settings.storage?.localDisk?.baseDir],
      ['secrets',settings.secrets?.localEncrypted?.keyFilePath],
    ]) {
      const required = section === 'database' ? settings.database && settings.database.mode !== 'postgres'
        : section === 'storage' ? settings.storage && settings.storage.provider !== 's3'
        : settings.secrets && (!settings.secrets.provider || settings.secrets.provider === 'local_encrypted');
      if (required && !value) fail(section + ' requires an explicit data path; schema defaults can select another instance');
      if (value && !nativePath(resolveDataPath(value))) fail('instance still contains Windows data paths');
    }
    if (settings.database && settings.database.backup?.enabled !== false && !settings.database.backup?.dir) fail('database backup requires an explicit data path; schema defaults can select another instance');
    if (settings.database?.backup?.dir && !nativePath(resolveDataPath(settings.database.backup.dir))) fail('instance still contains Windows data paths');
    const configuredBins = config.binPaths ?? ["/usr/local/bin", "/usr/bin", "/bin"];
    if (!Array.isArray(configuredBins) || configuredBins.some(value => !nativePath(value))) fail("tool directories must be native Linux paths");
    const bins = [...new Set([path.dirname(config.node), ...configuredBins])];
    const executable = path.basename(commands[1] ?? "");
    const directEntry = commands.findIndex((value,index) => index > 1 && [path.join(repository,"cli/src/index.ts"),path.join(repository,"cli/dist/index.js")].includes(path.resolve(repository,value)));
    const cliIndex = ["paperclip", "paperclipai"].includes(executable) ? 1
      : ["pnpm", "npm", "npx"].includes(executable) ? commands.findIndex((value, index) => index > 1 && ["paperclip", "paperclipai"].includes(value)) : ["node", "tsx"].includes(executable) ? directEntry : -1;
    const cliArguments = cliIndex < 0 ? [] : commands.slice(cliIndex + 1);
    if (executable === "npm" && commands.slice(2,cliIndex).some(value => ["run","run-script"].includes(value)) && cliArguments[0] === "--") cliArguments.shift();
    const endOptions = cliArguments.indexOf("--");
    if (endOptions >= 0) cliArguments.splice(endOptions);
    const optionValue = (name, short) => {
      const index = cliArguments.findLastIndex(value => value === name || value.startsWith(name + "=") || short && value.startsWith(short));
      if (index < 0) return undefined;
      const value = cliArguments[index];
      if (value.startsWith(name + "=")) return value.slice(name.length + 1);
      if (short && value.startsWith(short) && value !== short) return value.slice(short.length).replace(/^=/, "");
      return cliArguments[index + 1];
    };
    for (const [name,short,expected] of [["--config","-c",selectedConfig],["--data-dir","-d",config.paperclipHome]]) {
      const selected = optionValue(name,short);
      if (selected !== undefined && path.resolve(repository,selected) !== expected) fail(name + " selects another instance");
    }
    if (optionValue("--instance","-i") !== undefined && optionValue("--instance","-i") !== config.instanceId) fail("--instance selects another instance");
    let contextPath = path.join(config.paperclipHome, "context.json");
    for (let directory = repository;; directory = path.dirname(directory)) {
      const candidate = path.join(directory, ".paperclip", "context.json");
      if (fs.existsSync(candidate)) { contextPath = candidate; break; }
      if (path.dirname(directory) === directory) break;
    }
    if (optionValue("--context")) contextPath = path.resolve(repository, optionValue("--context"));
    const validateApiBase = value => {
      const target = new URL(value);
      if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || Number(target.port || 80) !== config.port || !["", "/"].includes(target.pathname) || target.username || target.password || target.search || target.hash) fail("CLI context targets another instance");
    };
    if (!nativePath(contextPath)) fail("CLI context must be a native Linux path");
    if (fs.existsSync(contextPath)) {
      const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
      const profile = context.profiles?.[optionValue("--profile")?.trim() || context.currentProfile || "default"];
      const target = optionValue("--api-base")?.trim() || process.env.PAPERCLIP_API_URL?.trim() || profile?.apiBase;
      if (target) validateApiBase(target);
    }
    if (optionValue("--api-base")) validateApiBase(optionValue("--api-base"));
    if (optionValue("--paperclip-url")) validateApiBase(optionValue("--paperclip-url"));
    const validateEnvironment = source => {
      for (const key of Object.keys(source)) if (["PAPERCLIP_AGENT_JWT_SECRET","BETTER_AUTH_SECRET","PAPERCLIP_TOOL_ACTION_SIGNING_SECRET","PAPERCLIP_SECRETS_MASTER_KEY"].includes(key) || key.startsWith("PAPERCLIP_SECRETS_AWS_")) {
        if (source[key] !== instanceEnvironment[key]) fail(key + " differs from the selected instance");
      }
      for (const key of Object.keys(source).filter(key => key === 'RUN_LOG_BASE_PATH' || key.startsWith('RUN_LOG_S3_'))) {
        if (source[key] !== instanceEnvironment[key]) fail(key + ' differs from the selected instance');
        if (key === 'RUN_LOG_BASE_PATH' && !nativePath(resolveDataPath(source[key]))) fail(key + ' must be a native Linux path');
      }
      if (source.PAPERCLIP_SERVER_HOST !== undefined && !['localhost','127.0.0.1','::1'].includes(source.PAPERCLIP_SERVER_HOST)) fail('PAPERCLIP_SERVER_HOST selects another instance');
      if (source.PAPERCLIP_SERVER_PORT !== undefined && Number(source.PAPERCLIP_SERVER_PORT) !== config.port) fail('PAPERCLIP_SERVER_PORT selects another instance');
      if (source.PAPERCLIP_RUNNER_BINARY !== undefined && !nativePath(source.PAPERCLIP_RUNNER_BINARY)) fail("PAPERCLIP_RUNNER_BINARY must be a native Linux path");
      for (const [key, expected] of [["PAPERCLIP_HOME", config.paperclipHome], ["PAPERCLIP_INSTANCE_ID", config.instanceId]]) {
        if (source[key] !== undefined && source[key] !== expected) fail(key + " selects another instance");
      }
      if (source.PAPERCLIP_CONFIG !== undefined && path.resolve(repository, source.PAPERCLIP_CONFIG) !== selectedConfig) fail("PAPERCLIP_CONFIG selects another instance");
      for (const [key, expected] of [["PAPERCLIP_CONTEXT", contextPath], ["PAPERCLIP_AUTH_STORE", path.join(config.paperclipHome, "auth.json")]]) {
        if (source[key] !== undefined && path.resolve(repository, source[key]) !== expected) fail(key + " selects another CLI state root");
      }
      if (source.PAPERCLIP_API_URL) validateApiBase(source.PAPERCLIP_API_URL);
      if (["true","1","yes","on"].includes(source.PAPERCLIP_IN_WORKTREE?.trim().toLowerCase())) fail("PAPERCLIP_IN_WORKTREE selects another scheduling context");
      for (const [key, expected] of [
        ["PAPERCLIP_SECRETS_PROVIDER", settings.secrets?.provider ?? "local_encrypted"],
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
    const instanceEnvironment = fs.existsSync(path.join(instance,".env")) ? parseEnv(fs.readFileSync(path.join(instance,".env"),"utf8")) : {};
    if (process.env.PAPERCLIP_SECRETS_MASTER_KEY !== undefined && process.env.PAPERCLIP_SECRETS_MASTER_KEY !== instanceEnvironment.PAPERCLIP_SECRETS_MASTER_KEY) fail("PAPERCLIP_SECRETS_MASTER_KEY differs from the selected instance");
    validateEnvironment(process.env);
    for (const filename of [path.join(instance, ".env"), path.join(repository, ".env"), path.join(repository, "server", ".env")]) {
      if (fs.existsSync(filename)) validateEnvironment(parseEnv(fs.readFileSync(filename, "utf8")));
    }
    if (process.env.WSL_DISTRO_NAME && !config.capacityPath) fail("capacityPath must select the Windows volume that contains the WSL virtual disk");
    if (config.capacityPath !== undefined && (!config.capacityPath.startsWith("/mnt/") || !/^[a-z]$/.test(config.capacityPath.split("/")[2]))) fail("capacityPath must select a Windows host volume");
    const capacityPath = fs.realpathSync(config.capacityPath ?? config.paperclipHome);
    if (config.capacityPath) {
      const mount = fs.realpathSync("/mnt/" + config.capacityPath.split("/")[2]);
      if (capacityPath !== mount && !capacityPath.startsWith(mount + "/")) fail("capacityPath resolves outside the selected Windows host volume");
    }
    const environment = { ...process.env, PATH: bins.join(":"), PAPERCLIP_HOME: config.paperclipHome, PAPERCLIP_INSTANCE_ID: config.instanceId, PAPERCLIP_CONFIG: selectedConfig, PAPERCLIP_DISABLE_CWD_ENV_FILE: "true", PAPERCLIP_CONTEXT: contextPath, PAPERCLIP_AUTH_STORE: path.join(config.paperclipHome, "auth.json") };
    for (const key of ["CARGO_HOME", "RUSTUP_HOME"]) if (config[key]) { if (!nativePath(config[key])) fail("invalid " + key); environment[key] = config[key]; }
    const capacity = fs.statfsSync(capacityPath);
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
        const sockets = new Set(fs.readFileSync("/proc/net/tcp","utf8").trim().split("\n").slice(1).flatMap(line => {
          const fields = line.trim().split(/\s+/);
          const [address,port] = fields[1].split(":");
          return fields[3] === "0A" && ["0100007F","00000000"].includes(address) && parseInt(port,16) === config.port ? ["socket:[" + fields[9] + "]"] : [];
        }));
        let ownsListener = false;
        for (const pid of fs.readdirSync("/proc").filter(value => /^\d+$/.test(value))) {
          try {
            if (fs.statSync("/proc/" + pid).uid !== process.getuid()) continue;
            if (!fs.readdirSync("/proc/" + pid + "/fd").some(fd => {
              try { return sockets.has(fs.readlinkSync("/proc/" + pid + "/fd/" + fd)); } catch { return false; }
            })) continue;
            const values = Object.fromEntries(fs.readFileSync("/proc/" + pid + "/environ","utf8").split("\0").filter(Boolean).map(value => { const index = value.indexOf("="); return [value.slice(0,index),value.slice(index+1)]; }));
            ownsListener = values.PAPERCLIP_CONFIG === selectedConfig && values.PAPERCLIP_HOME === config.paperclipHome && values.PAPERCLIP_INSTANCE_ID === config.instanceId;
            if (ownsListener) break;
          } catch {}
        }
        if (!ownsListener) fail("health listener does not belong to the selected instance: restart the selected service through this helper to record its identity");
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
