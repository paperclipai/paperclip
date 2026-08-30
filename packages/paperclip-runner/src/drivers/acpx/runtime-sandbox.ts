import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { createSanitizedAcpxSpawnInput } from "./environment.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";
import type { AcpxRecoveryBinding } from "./recovery-identity.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SANDBOX_ENVIRONMENT_BYTES = 512 * 1024;

export interface AcpxRuntimeSandbox {
  root: string;
  stateDirectory: string;
  homeDirectory: string;
  configDirectory: string;
  dataDirectory: string;
  cacheDirectory: string;
  agentHomeDirectory: string;
  workspaceRecordPath: string;
  launchEnvironment: Readonly<NodeJS.ProcessEnv>;
  persistedEnvironment: Readonly<NodeJS.ProcessEnv>;
}

/** Prepare the private filesystem and environment visible to an ACPX agent. */
export async function prepareAcpxRuntimeSandbox(input: {
  binding: AcpxRecoveryBinding;
  agent: QualifiedAcpxAgent;
  environment?: NodeJS.ProcessEnv;
}): Promise<AcpxRuntimeSandbox> {
  const expectedRoot = input.binding.runtimeRoot;
  if (resolve(expectedRoot) !== expectedRoot) {
    throw new Error("ACPX runtime root must be an absolute normalized path");
  }
  const acpxDirectory = dirname(expectedRoot);
  const runtimeDirectory = dirname(acpxDirectory);
  if (basename(acpxDirectory) !== "acpx") {
    throw new Error("ACPX runtime root is outside its expected namespace");
  }
  const physicalRuntimeDirectory = await realpath(runtimeDirectory);
  const physicalAcpxDirectory = await ensurePrivateDirectory(
    acpxDirectory,
    physicalRuntimeDirectory,
  );
  const root = await ensurePrivateDirectory(
    expectedRoot,
    physicalAcpxDirectory,
  );
  const stateDirectory = await ensurePrivateDirectory(
    join(root, "acpx-state"),
    root,
  );
  const homeDirectory = await ensurePrivateDirectory(join(root, "home"), root);
  const configDirectory = await ensurePrivateDirectory(
    join(root, "config"),
    root,
  );
  const dataDirectory = await ensurePrivateDirectory(join(root, "data"), root);
  const cacheDirectory = await ensurePrivateDirectory(
    join(root, "cache"),
    root,
  );
  const agentHomeDirectory = await ensurePrivateDirectory(
    join(root, `${input.agent}-home`),
    root,
  );
  const workspaceRecordPath = join(root, "workspace");
  await writePrivateFile(
    workspaceRecordPath,
    `${input.binding.workspacePath}\n`,
  );
  if (input.agent === "pi") {
    await writePrivateFile(
      join(agentHomeDirectory, "settings.json"),
      `${JSON.stringify({
        quietStartup: true,
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
      })}\n`,
    );
  }

  const sanitizedSpawnInput = createSanitizedAcpxSpawnInput(
    input.environment,
    input.agent,
  );
  // The sanitizer deliberately returns an opaque, frozen launch boundary.
  // Build the sandbox-owned mutable copy only from that projected environment
  // before adding paths that were created and validated above.
  const launchEnvironment: NodeJS.ProcessEnv = {
    ...sanitizedSpawnInput.env,
  };
  Object.assign(launchEnvironment, {
    HOME: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: dataDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    PAPERCLIP_ACPX_PROFILE: input.agent,
    PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1",
    ...(input.agent === "pi"
      ? {
          PI_CODING_AGENT_DIR: agentHomeDirectory,
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
        }
      : {}),
    ...(input.agent === "claude"
      ? { CLAUDE_CONFIG_DIR: agentHomeDirectory }
      : {}),
    ...(input.agent === "codex"
      ? {
          CODEX_HOME: agentHomeDirectory,
          NO_BROWSER: "1",
          ...(launchEnvironment.CODEX_API_KEY ||
          launchEnvironment.OPENAI_API_KEY
            ? { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) }
            : {}),
        }
      : {}),
  });
  validateEnvironmentSize(launchEnvironment);
  const persistedEnvironment = Object.fromEntries(
    Object.entries(launchEnvironment).filter(
      ([name, value]) =>
        typeof value === "string" && isPersistableEnvironmentName(name),
    ),
  );
  return {
    root,
    stateDirectory,
    homeDirectory,
    configDirectory,
    dataDirectory,
    cacheDirectory,
    agentHomeDirectory,
    workspaceRecordPath,
    launchEnvironment: Object.freeze({ ...launchEnvironment }),
    persistedEnvironment: Object.freeze(persistedEnvironment),
  };
}

async function ensurePrivateDirectory(
  directory: string,
  physicalParent: string,
): Promise<string> {
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  let handle: FileHandle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error("ACPX sandbox path must be a real directory");
  }
  let physical: string;
  try {
    const opened = await handle.stat();
    const entry = await lstat(directory);
    if (
      !opened.isDirectory() ||
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !sameFile(entry, opened)
    ) {
      throw new Error("ACPX sandbox path must be a real directory");
    }
    // Apply permissions to the inode that was opened without following links.
    // A directory-entry swap can therefore never redirect chmod to its target.
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    physical = await realpath(directory);
    const verifiedEntry = await lstat(directory);
    if (!sameFile(verifiedEntry, opened)) {
      throw new Error("ACPX sandbox directory changed during preparation");
    }
    if (!isInside(physicalParent, physical)) {
      throw new Error("ACPX sandbox directory escaped its private parent");
    }
    // Persist the child inode before the directory entry that names it.
    if (process.platform !== "win32") await handle.sync();
  } finally {
    await handle.close();
  }
  // Sync the parent even during recovery: an earlier process may have created
  // the entry and crashed before making that mkdir durable.
  await syncDirectory(physicalParent);
  return physical;
}

async function writePrivateFile(
  filePath: string,
  value: string,
): Promise<void> {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 1 || bytes.length > 64 * 1024) {
    throw new Error("ACPX sandbox file exceeds its bounded size");
  }
  const temporaryPath = `${filePath}.tmp-${randomBytes(12).toString("hex")}`;
  let handle: FileHandle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
  } catch {
    throw new Error("ACPX sandbox file could not be opened without links");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("ACPX sandbox path is not a file");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, filePath);
    await syncDirectory(dirname(filePath));
    return;
  } finally {
    bytes.fill(0);
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateEnvironmentSize(environment: NodeJS.ProcessEnv): void {
  const bytes = Object.entries(environment).reduce(
    (total, [name, value]) =>
      total + Buffer.byteLength(name) + Buffer.byteLength(value ?? ""),
    0,
  );
  if (bytes > MAX_SANDBOX_ENVIRONMENT_BYTES) {
    throw new Error("ACPX launch environment exceeds its bounded size");
  }
}

function isPersistableEnvironmentName(name: string): boolean {
  return (
    /^(?:PATH|LANG|LANGUAGE|TZ|TMPDIR|TEMP|TMP|LC_[A-Z0-9_]{1,32})$/.test(
      name,
    ) ||
    /^(?:HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)$/.test(name) ||
    /^(?:PAPERCLIP_ACPX_PROFILE|PAPERCLIP_ACPX_ISOLATED_CONTEXT)$/.test(name) ||
    /^(?:PI_CODING_AGENT_DIR|PI_SKIP_VERSION_CHECK|PI_TELEMETRY)$/.test(name) ||
    /^(?:CLAUDE_CONFIG_DIR|CODEX_HOME|NO_BROWSER|DEFAULT_AUTH_REQUEST)$/.test(
      name,
    )
  );
}

function isInside(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return (
    childPath.length > 0 &&
    childPath !== ".." &&
    !childPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(childPath)
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}
