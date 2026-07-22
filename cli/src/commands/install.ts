import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  addManagedPathBlock,
  assertManagedShimWritable,
  buildNextManifest,
  flipCurrentAtomic,
  payloadPathFor,
  pruneInstallPayloads,
  readInstallManifest,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
  writeManagedShim,
  type InstallChannel,
  type InstallRecord,
} from "../install-store.js";

const execFileAsync = promisify(execFile);
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type InstallOptions = { canary?: boolean; version?: string; yes?: boolean };

type CommandRunner = (
  file: string,
  args: string[],
  options?: Parameters<typeof execFileAsync>[2],
) => Promise<{ stdout: string; stderr: string }>;

function assertSupportedNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Managed installs require Node.js 20 or newer (found ${process.version}).`);
  }
}

export function resolveNpmInstallRequest(options: InstallOptions): {
  spec: string;
  channel: InstallChannel;
} {
  if (options.canary && options.version) throw new Error("Choose either --canary or --version, not both.");
  if (options.version) {
    const version = options.version.trim();
    if (!EXACT_VERSION_PATTERN.test(version)) {
      throw new Error(`--version requires an exact published version, received '${options.version}'.`);
    }
    return { spec: version, channel: "pinned" };
  }
  return options.canary ? { spec: "canary", channel: "canary" } : { spec: "latest", channel: "latest" };
}

function parseResolvedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("npm returned an empty version response.");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    if (EXACT_VERSION_PATTERN.test(trimmed)) return trimmed;
  }
  throw new Error(`npm returned an unexpected version response: ${trimmed}`);
}

async function resolvePublishedVersion(spec: string, runCommand: CommandRunner): Promise<string> {
  const result = await runCommand(
    "npm",
    ["view", `paperclipai@${spec}`, "version", "--json", `--registry=${PUBLIC_NPM_REGISTRY}`],
    { maxBuffer: 1024 * 1024 },
  );
  return parseResolvedVersion(result.stdout);
}

function payloadEntrypoint(payloadPath: string): string {
  return path.join(payloadPath, "node_modules", "paperclipai", "dist", "index.js");
}

async function smokePayload(payloadPath: string, expectedVersion: string, runCommand: CommandRunner): Promise<void> {
  const entrypoint = payloadEntrypoint(payloadPath);
  if (!fs.existsSync(entrypoint)) throw new Error(`Installed package is missing its CLI entrypoint: ${entrypoint}`);
  const result = await runCommand(process.execPath, [entrypoint, "--version"], { maxBuffer: 1024 * 1024 });
  const reportedVersion = result.stdout.trim().split(/\s+/)[0];
  if (reportedVersion !== expectedVersion) {
    throw new Error(`Installed CLI smoke check reported ${reportedVersion || "no version"}; expected ${expectedVersion}.`);
  }
}

async function installNpmPayload(
  version: string,
  runCommand: CommandRunner,
  paths = resolveInstallStorePaths(),
): Promise<{ payloadPath: string; reused: boolean }> {
  const payloadPath = payloadPathFor(paths, "npm", version);
  if (fs.existsSync(payloadPath)) {
    await smokePayload(payloadPath, version, runCommand);
    return { payloadPath, reused: true };
  }
  const sourceRoot = path.dirname(payloadPath);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to install into unsafe payload root ${sourceRoot}.`);
  }
  fs.chmodSync(paths.cliRoot, 0o700);
  fs.chmodSync(paths.installsRoot, 0o700);
  fs.chmodSync(sourceRoot, 0o700);
  const stagingPath = path.join(sourceRoot, `.${version}.tmp-${process.pid}-${Date.now()}`);
  const npmUserConfigPath = path.join(sourceRoot, `.npmrc-${process.pid}-${Date.now()}`);
  fs.rmSync(stagingPath, { recursive: true, force: true });
  try {
    fs.writeFileSync(
      npmUserConfigPath,
      `registry=${PUBLIC_NPM_REGISTRY}\n@paperclipai:registry=${PUBLIC_NPM_REGISTRY}\n`,
      { mode: 0o600 },
    );
    await runCommand(
      "npm",
      [
        "install",
        "--prefix",
        stagingPath,
        `paperclipai@${version}`,
        `--registry=${PUBLIC_NPM_REGISTRY}`,
        `--@paperclipai:registry=${PUBLIC_NPM_REGISTRY}`,
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: sourceRoot,
        env: { ...process.env, npm_config_userconfig: npmUserConfigPath },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await smokePayload(stagingPath, version, runCommand);
    fs.renameSync(stagingPath, payloadPath);
    return { payloadPath, reused: false };
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.rmSync(npmUserConfigPath, { force: true });
  }
}

function pathContains(directory: string): boolean {
  const normalized = path.resolve(directory);
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((entry) => path.resolve(entry) === normalized);
}

function shellRcPath(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const shell = path.basename(process.env.SHELL ?? "");
  if (shell === "bash") return path.join(home, ".bashrc");
  if (shell === "zsh") return path.join(home, ".zshrc");
  return null;
}

async function ensureShimOnPath(options: InstallOptions): Promise<void> {
  const paths = resolveInstallStorePaths();
  const binDir = path.dirname(paths.shimPath);
  if (pathContains(binDir)) return;
  const manualInstruction = `export PATH="$HOME/.local/bin:$PATH"`;
  const rcPath = shellRcPath();
  if (!process.stdin.isTTY || !process.stdout.isTTY || !rcPath) {
    console.log(pc.yellow(`Add Paperclip to PATH for this shell:\n  ${manualInstruction}`));
    return;
  }
  const confirmed = options.yes === true ? true : await p.confirm({ message: `Add ~/.local/bin to PATH in ${rcPath}?`, initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.yellow(`PATH was not changed. Run:\n  ${manualInstruction}`));
    return;
  }
  const changed = addManagedPathBlock(rcPath);
  console.log(changed ? pc.green(`Updated ${rcPath}.`) : pc.dim(`${rcPath} already contains the PATH block.`));
}

export async function installCommand(
  options: InstallOptions,
  dependencies: { runCommand?: CommandRunner; now?: () => Date } = {},
): Promise<void> {
  assertSupportedNodeVersion();
  const runCommand = dependencies.runCommand ?? execFileAsync;
  const request = resolveNpmInstallRequest(options);
  console.log(`Resolving paperclipai@${request.spec} from ${PUBLIC_NPM_REGISTRY}...`);
  const version = await resolvePublishedVersion(request.spec, runCommand);
  console.log(`Installing paperclipai@${version}...`);

  const paths = resolveInstallStorePaths();
  const installed = await withInstallStoreLock(async () => {
    assertManagedShimWritable(paths);
    const currentManifest = readInstallManifest(paths);
    const payload = await installNpmPayload(version, runCommand, paths);
    const record: InstallRecord = {
      source: "npm",
      version,
      channel: request.channel,
      payloadPath: payload.payloadPath,
      installedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    };
    const nextManifest = buildNextManifest(record, currentManifest);
    const oldTarget = fs.existsSync(paths.currentPath) ? fs.readlinkSync(paths.currentPath) : null;
    flipCurrentAtomic(payload.payloadPath, paths);
    try {
      writeInstallManifestAtomic(nextManifest, paths);
    } catch (error) {
      if (oldTarget) flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths);
      else fs.rmSync(paths.currentPath, { force: true });
      throw error;
    }
    writeManagedShim(paths);
    pruneInstallPayloads(nextManifest, paths);
    return payload;
  }, paths);
  await ensureShimOnPath(options);

  console.log(pc.green(`${installed.reused ? "Activated cached" : "Installed"} paperclipai ${version} (${request.channel}).`));
  console.log(pc.dim(`Payload: ${installed.payloadPath}`));
  console.log(`Run ${pc.cyan("paperclipai --version")} to verify the managed install.`);
}
