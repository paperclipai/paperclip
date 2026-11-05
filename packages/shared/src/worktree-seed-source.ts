import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceId } from "./home-paths.js";

export type WorktreeSeedSourceDiagnostic = {
  configPath?: unknown;
  instanceId?: unknown;
};

export type CanonicalWorktreeSeedSource = {
  baseWorkspaceCwd: string | null;
  configPath: string;
  instanceId: string;
  targetConfigPath: string;
  targetInstanceId: string;
};

export type RegisteredWorktreeSeedSourceInput = {
  registeredBaseWorkspaceCwd?: string | null;
  explicitSourceConfigPath?: string | null;
  targetConfigPath: string;
  expectedTargetInstanceId: string;
};

function readInstanceId(configPath: string, label: "source" | "target"): string {
  const configDir = path.dirname(configPath);
  const envPath = path.join(configDir, ".env");
  if (!existsSync(envPath)) {
    // An instance-root config (`<home>/instances/<id>/config.json`) names its instance
    // by directory rather than by an adjacent .env; worktree configs always ship one.
    if (path.basename(path.dirname(configDir)) === "instances") {
      return resolvePaperclipInstanceId(path.basename(configDir));
    }
    throw new Error(`Registered ${label} Paperclip config is missing its adjacent .env instance pointer.`);
  }
  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const match = rawLine.match(
      /^\s*(?:export\s+)?PAPERCLIP_INSTANCE_ID\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/,
    );
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`Registered ${label} Paperclip config has no PAPERCLIP_INSTANCE_ID binding.`);
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "unknown error";
}

/**
 * Inspect a directory entry without following it, returning null only when it is absent.
 *
 * Any other failure means the declared path is unreadable or malformed, and a guess there
 * would silently seed from a different instance.
 */
function inspectDeclaredEntry(entryPath: string, configPath: string, detail?: string): Stats | null {
  try {
    return lstatSync(entryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(
      `Registered base project workspace Paperclip config at ${configPath} cannot be inspected (${errorCode(error)}${detail ?? ""}).`,
    );
  }
}

/**
 * Whether a base project workspace declares an instance config of its own.
 *
 * This tests directory entries and does not follow them. A dangling or aliased symlink,
 * at the config itself or at the `.paperclip` directory holding it, still counts as a
 * declared config, so the resolver rejects the malformed source instead of falling back
 * to another one.
 */
export function baseWorkspaceDeclaresInstanceConfig(baseWorkspaceCwd: string): boolean {
  const configDir = path.join(baseWorkspaceCwd, ".paperclip");
  const configPath = path.join(configDir, "config.json");
  if (inspectDeclaredEntry(configPath, configPath)) return true;

  // The probe above resolves `.paperclip` before it reaches the config, so a broken link
  // there also reports ENOENT. Only an absent or traversable `.paperclip` lets the caller
  // name another source; a link that hides whatever it points at is malformed, not empty.
  const configDirEntry = inspectDeclaredEntry(configDir, configPath, " on its .paperclip entry");
  if (configDirEntry?.isSymbolicLink()) {
    try {
      statSync(configDir);
    } catch (error) {
      throw new Error(
        `Registered base project workspace Paperclip config at ${configPath} cannot be inspected (${errorCode(error)} on its .paperclip symlink target).`,
      );
    }
  }
  return false;
}

function canonicalRegularFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    throw new Error(`${label} does not exist at ${resolved}.`);
  }
  if (canonical !== resolved || lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`${label} must be a canonical path and cannot use a symlink alias.`);
  }
  if (!lstatSync(canonical).isFile()) {
    throw new Error(`${label} is not a regular file at ${canonical}.`);
  }
  return canonical;
}

/** Resolve the authoritative source and target identities without consulting diagnostics. */
export function resolveRegisteredWorktreeSeedSource(
  input: RegisteredWorktreeSeedSourceInput,
): CanonicalWorktreeSeedSource {
  const registeredCwd = input.registeredBaseWorkspaceCwd?.trim();
  const explicitSource = input.explicitSourceConfigPath?.trim();
  if (!registeredCwd && !explicitSource) {
    throw new Error(
      "Worktree seed source is not registered. Managed boot requires a project workspace; manual boot requires --from-config.",
    );
  }

  let canonicalBaseCwd: string | null = null;
  let registeredConfigPath: string | null = null;
  if (registeredCwd) {
    const resolvedRegisteredCwd = path.resolve(registeredCwd);
    try {
      canonicalBaseCwd = realpathSync(resolvedRegisteredCwd);
    } catch {
      throw new Error(`Registered base project workspace does not exist at ${resolvedRegisteredCwd}.`);
    }
    if (canonicalBaseCwd !== resolvedRegisteredCwd) {
      throw new Error("Registered base project workspace must be canonical and cannot use a symlink alias.");
    }
    if (!lstatSync(canonicalBaseCwd).isDirectory()) {
      throw new Error(`Registered base project workspace is not a directory at ${canonicalBaseCwd}.`);
    }
    // A base workspace that is a plain checkout carries no instance config of its own.
    // The caller's explicit source supplies it, and stays subject to every check below.
    registeredConfigPath = baseWorkspaceDeclaresInstanceConfig(canonicalBaseCwd)
      ? path.join(canonicalBaseCwd, ".paperclip", "config.json")
      : null;
  }

  const selectedPath = registeredConfigPath ?? explicitSource;
  if (!selectedPath) {
    throw new Error(
      "Registered base project workspace has no Paperclip config of its own and no explicit source was provided.",
    );
  }
  const canonicalSourceConfigPath = canonicalRegularFile(selectedPath, "Registered source Paperclip config");
  if (registeredConfigPath && canonicalSourceConfigPath !== registeredConfigPath) {
    throw new Error("Registered source Paperclip config escapes the base project workspace or uses a symlink alias.");
  }

  if (explicitSource) {
    const canonicalExplicitSource = canonicalRegularFile(explicitSource, "Explicit source Paperclip config");
    if (canonicalExplicitSource !== canonicalSourceConfigPath) {
      throw new Error("Explicit source Paperclip config does not match the registered base project workspace.");
    }
  }

  const canonicalTargetConfigPath = canonicalRegularFile(
    input.targetConfigPath,
    "Target worktree Paperclip config",
  );
  if (canonicalSourceConfigPath === canonicalTargetConfigPath) {
    throw new Error("Source and target Paperclip configs are the same canonical file.");
  }

  const sourceInstanceId = readInstanceId(canonicalSourceConfigPath, "source");
  const targetInstanceId = readInstanceId(canonicalTargetConfigPath, "target");
  if (targetInstanceId !== input.expectedTargetInstanceId) {
    throw new Error("Target Paperclip instance does not match the registered worktree instance.");
  }
  if (sourceInstanceId === targetInstanceId) {
    throw new Error("Source and target Paperclip configs name the same instance.");
  }

  return {
    baseWorkspaceCwd: canonicalBaseCwd,
    configPath: canonicalSourceConfigPath,
    instanceId: sourceInstanceId,
    targetConfigPath: canonicalTargetConfigPath,
    targetInstanceId,
  };
}

/**
 * Resolve a worktree seed source without granting authority to the seed manifest.
 *
 * A managed caller supplies the project-workspace cwd from its server-owned row.
 * An operator may instead supply an explicit source config. A base workspace that
 * carries its own `.paperclip/config.json` stays authoritative, so an explicit path
 * must equal it; a base workspace that is a plain checkout has none, and the explicit
 * path supplies the source. Manifest source fields are diagnostic assertions only and
 * never select the returned source.
 */
export function resolveCanonicalWorktreeSeedSource(input: RegisteredWorktreeSeedSourceInput & {
  manifestSource: WorktreeSeedSourceDiagnostic | null | undefined;
  manifestTargetInstanceId?: unknown;
}): CanonicalWorktreeSeedSource {
  const registered = resolveRegisteredWorktreeSeedSource(input);
  const diagnosticPath = typeof input.manifestSource?.configPath === "string"
    ? input.manifestSource.configPath.trim()
    : "";
  if (!diagnosticPath) {
    throw new Error("Worktree seed manifest is missing source path diagnostics.");
  }
  const canonicalDiagnosticPath = canonicalRegularFile(
    diagnosticPath,
    "Worktree seed manifest source diagnostic",
  );
  if (path.resolve(diagnosticPath) !== registered.configPath || canonicalDiagnosticPath !== registered.configPath) {
    throw new Error("Worktree seed manifest source path does not match the registered canonical source.");
  }
  if (input.manifestSource?.instanceId !== registered.instanceId) {
    throw new Error("Worktree seed manifest source instance does not match the registered source instance.");
  }
  if (input.manifestTargetInstanceId !== registered.targetInstanceId) {
    throw new Error("Worktree seed manifest target instance does not match the registered target instance.");
  }
  return registered;
}
