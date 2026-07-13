import fs from "node:fs/promises";
import path from "node:path";

export type LocalProcessSandboxAccess = "ro" | "rw";

export interface LocalProcessSandboxPath {
  path: string;
  access: LocalProcessSandboxAccess;
}

export interface LocalProcessSandboxOptions {
  workspaceDir: string;
  managedPaths?: LocalProcessSandboxPath[];
  extraPaths?: LocalProcessSandboxPath[];
  homeDir?: string | null;
  command?: string;
}

export interface LocalProcessSandboxSpawnTarget {
  command: string;
  args: string[];
  cwd: string;
}

const SYSTEM_READ_PATHS = [
  "/usr",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/gitconfig",
] as const;

function normalizeAbsolutePath(candidate: string, label: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(trimmed);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function parentDirectories(candidate: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function addParentDirectories(args: string[], created: Set<string>, candidate: string): void {
  for (const directory of parentDirectories(candidate)) {
    if (created.has(directory)) continue;
    args.push("--dir", directory);
    created.add(directory);
  }
}

async function nearestPackageRoot(candidate: string): Promise<string> {
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return path.dirname(candidate);
}

async function executableReadPaths(command: string): Promise<string[]> {
  const paths = new Set<string>([path.dirname(command)]);
  const realCommand = await fs.realpath(command).catch(() => command);
  paths.add(await nearestPackageRoot(realCommand));
  return Array.from(paths);
}

export async function buildLocalProcessSandboxSpawnTarget(input: {
  executable: string;
  args: string[];
  cwd: string;
  options: LocalProcessSandboxOptions;
}): Promise<LocalProcessSandboxSpawnTarget> {
  if (process.platform !== "linux") {
    throw new Error('filesystemScope="workspace" is currently supported only on Linux.');
  }
  const workspaceDir = normalizeAbsolutePath(input.options.workspaceDir, "Sandbox workspaceDir");
  const cwd = normalizeAbsolutePath(input.cwd, "Sandbox cwd");
  const relativeCwd = path.relative(workspaceDir, cwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new Error(`Sandbox cwd "${cwd}" must be inside workspaceDir "${workspaceDir}".`);
  }

  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
  ];
  const created = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
  const mounted = new Set<string>();
  const mount = async (source: string, access: LocalProcessSandboxAccess) => {
    const normalized = normalizeAbsolutePath(source, "Sandbox path");
    if (mounted.has(normalized) || !(await pathExists(normalized))) return;
    addParentDirectories(args, created, normalized);
    args.push(access === "rw" ? "--bind" : "--ro-bind", normalized, normalized);
    mounted.add(normalized);
    created.add(normalized);
  };

  for (const systemPath of SYSTEM_READ_PATHS) await mount(systemPath, "ro");
  for (const executablePath of await executableReadPaths(input.executable)) await mount(executablePath, "ro");
  for (const managedPath of input.options.managedPaths ?? []) await mount(managedPath.path, managedPath.access);
  for (const extraPath of input.options.extraPaths ?? []) await mount(extraPath.path, extraPath.access);
  await mount(workspaceDir, "rw");
  args.push("--chdir", cwd, "--", input.executable, ...input.args);
  return { command: input.options.command?.trim() || "bwrap", args, cwd: "/" };
}

export function parseLocalProcessSandboxExtraPaths(value: unknown): LocalProcessSandboxPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: normalizeAbsolutePath(entry, `filesystemExtraPaths[${index}]`), access: "ro" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`filesystemExtraPaths[${index}] must be an absolute path or { path, access } object.`);
    }
    const raw = entry as Record<string, unknown>;
    const access = raw.access === "rw" ? "rw" : raw.access === "ro" || raw.access == null ? "ro" : null;
    if (!access || typeof raw.path !== "string") {
      throw new Error(`filesystemExtraPaths[${index}] must use access "ro" or "rw" and an absolute path.`);
    }
    return { path: normalizeAbsolutePath(raw.path, `filesystemExtraPaths[${index}].path`), access };
  });
}
