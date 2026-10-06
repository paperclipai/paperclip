import { randomBytes } from "node:crypto";
import {
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
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
import { claudePaperclipPermissionRules } from "./permission-policy.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";
import {
  resolveAcpxRuntimeRoot,
  type AcpxRecoveryBinding,
} from "./recovery-identity.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SANDBOX_ENVIRONMENT_BYTES = 512 * 1024;
const MAX_WORKSPACE_RECORD_BYTES = 64 * 1024;

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
  /** The host sandbox must protect these runtime/config paths from tools. */
  protectedPaths: readonly string[];
}

/** A recovered workspace pinned until the provider process is admitted. */
export interface AcpxRecoveryWorkspaceLease {
  readonly path: string;
  assertHeld(): void;
  close(): Promise<void>;
}

export interface AcpxRecoveryWorkspaceReadDependencies {
  /** Internal seam for racing a parent-directory replacement in tests. */
  afterRuntimeRootPinned?: () => Promise<void>;
}

/** Read the private workspace binding used to reopen one exact ACPX session. */
export async function readAcpxRecoveryWorkspace(
  input: {
    runtimeDirectory: string;
    normalizedSessionId: string;
  },
  dependencies: AcpxRecoveryWorkspaceReadDependencies = {},
): Promise<AcpxRecoveryWorkspaceLease> {
  const runtimeRoot = await resolveAcpxRuntimeRoot(
    input.runtimeDirectory,
    input.normalizedSessionId,
  );
  const namespace = dirname(runtimeRoot);
  let physicalNamespace: string;
  let physicalRuntimeRoot: string;
  try {
    const [namespaceMetadata, rootMetadata] = await Promise.all([
      lstat(namespace),
      lstat(runtimeRoot),
    ]);
    if (
      namespaceMetadata.isSymbolicLink() ||
      !namespaceMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory()
    ) {
      throw new Error("invalid recovery directory");
    }
    [physicalNamespace, physicalRuntimeRoot] = await Promise.all([
      realpath(namespace),
      realpath(runtimeRoot),
    ]);
  } catch {
    throw new Error("ACPX recovery runtime directory is unavailable");
  }
  if (!isInside(physicalNamespace, physicalRuntimeRoot)) {
    throw new Error("ACPX recovery runtime directory escaped its namespace");
  }

  let namespaceHandle: FileHandle | null = null;
  let rootHandle: FileHandle | null = null;
  let workspaceHandle: FileHandle | null = null;
  try {
    namespaceHandle = await openPinnedDirectory(physicalNamespace);
    rootHandle = await openPinnedDirectory(physicalRuntimeRoot);
    assertPinnedDirectory(
      physicalNamespace,
      physicalNamespace,
      namespaceHandle,
      "ACPX recovery namespace changed during admission",
    );
    assertPinnedDirectory(
      physicalRuntimeRoot,
      physicalRuntimeRoot,
      rootHandle,
      "ACPX recovery runtime directory changed during admission",
    );
    await dependencies.afterRuntimeRootPinned?.();

    const recordPath = join(physicalRuntimeRoot, "workspace");
    let recordHandle: FileHandle;
    try {
      assertPinnedDirectory(
        physicalRuntimeRoot,
        physicalRuntimeRoot,
        rootHandle,
        "ACPX recovery runtime directory changed before record open",
      );
      recordHandle = await open(
        recordPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch {
      throw new Error("ACPX recovery workspace record is unavailable");
    }
    try {
      assertPinnedDirectory(
        physicalRuntimeRoot,
        physicalRuntimeRoot,
        rootHandle,
        "ACPX recovery runtime directory changed during record open",
      );
      const before = await recordHandle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size < 2n ||
        before.size > BigInt(MAX_WORKSPACE_RECORD_BYTES)
      ) {
        throw new Error("ACPX recovery workspace record is invalid");
      }
      assertPinnedFile(recordPath, before);
      const bytes = await readFile(recordHandle);
      const after = await recordHandle.stat({ bigint: true });
      if (
        bytes.length !== Number(before.size) ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error("ACPX recovery workspace record changed while read");
      }
      assertPinnedFile(recordPath, after);
      assertPinnedDirectory(
        physicalRuntimeRoot,
        physicalRuntimeRoot,
        rootHandle,
        "ACPX recovery runtime directory changed while record was read",
      );

      const workspace = bytes.toString("utf8").replace(/\n$/, "");
      if (!workspace || /[\u0000\r\n]/.test(workspace)) {
        throw new Error("ACPX recovery workspace record is invalid");
      }
      let physicalWorkspace: string;
      try {
        physicalWorkspace = await realpath(workspace);
        workspaceHandle = await openPinnedDirectory(physicalWorkspace);
      } catch {
        throw new Error("ACPX recovery workspace is unavailable");
      }
      if (physicalWorkspace === dirname(physicalWorkspace)) {
        throw new Error("ACPX recovery workspace is not a non-root directory");
      }
      if (!namespaceHandle || !rootHandle || !workspaceHandle) {
        throw new Error("ACPX recovery workspace handles are unavailable");
      }
      const pinnedNamespace = namespaceHandle;
      const pinnedRoot = rootHandle;
      const pinnedWorkspace = workspaceHandle;
      let closed = false;
      const lease: AcpxRecoveryWorkspaceLease = {
        path: physicalWorkspace,
        assertHeld() {
          if (closed) throw new Error("ACPX recovery workspace lease is closed");
          assertPinnedDirectory(
            physicalNamespace,
            physicalNamespace,
            pinnedNamespace,
            "ACPX recovery namespace changed before provider admission",
          );
          assertPinnedDirectory(
            physicalRuntimeRoot,
            physicalRuntimeRoot,
            pinnedRoot,
            "ACPX recovery runtime directory changed before provider admission",
          );
          assertPinnedDirectory(
            physicalWorkspace,
            physicalWorkspace,
            pinnedWorkspace,
            "ACPX recovery workspace changed before provider admission",
          );
        },
        async close() {
          if (closed) return;
          closed = true;
          await closeRecoveryHandles([
            pinnedWorkspace,
            pinnedRoot,
            pinnedNamespace,
          ]);
        },
      };
      lease.assertHeld();
      namespaceHandle = null;
      rootHandle = null;
      workspaceHandle = null;
      return lease;
    } finally {
      await recordHandle.close();
    }
  } finally {
    await closeRecoveryHandles([
      workspaceHandle,
      rootHandle,
      namespaceHandle,
    ]);
  }
}

async function openPinnedDirectory(path: string): Promise<FileHandle> {
  return await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
}

function assertPinnedDirectory(
  path: string,
  expectedPhysicalPath: string,
  handle: FileHandle,
  message: string,
): void {
  try {
    const descriptor = fstatSync(handle.fd, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (
      !descriptor.isDirectory() ||
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !sameBigIntFile(descriptor, entry) ||
      realpathSync(path) !== expectedPhysicalPath
    ) {
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    throw new Error(message);
  }
}

function assertPinnedFile(path: string, descriptor: BigIntStats): void {
  let entry: BigIntStats;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch {
    throw new Error("ACPX recovery workspace record changed while read");
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    !sameBigIntFile(descriptor, entry)
  ) {
    throw new Error("ACPX recovery workspace record changed while read");
  }
}

function sameBigIntFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function closeRecoveryHandles(
  handles: readonly (FileHandle | null)[],
): Promise<void> {
  const results = await Promise.allSettled(
    handles
      .filter((handle): handle is FileHandle => handle !== null)
      .map((handle) => handle.close()),
  );
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    )
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close ACPX recovery handles");
  }
}

export interface AcpxProviderRuntimePolicy {
  /** Task execution policy, independent of provider permission auto-approval. */
  readOnly: boolean;
  /** Assigned, verified skill roots. Never taken from ambient provider config. */
  readRoots?: readonly string[];
  systemInstructions?: string;
  protectedPaths?: readonly string[];
}

/** Prepare the private filesystem and environment visible to an ACPX agent. */
export async function prepareAcpxRuntimeSandbox(input: {
  binding: AcpxRecoveryBinding;
  agent: QualifiedAcpxAgent;
  environment?: NodeJS.ProcessEnv;
  /** Public operations on the runner-owned Paperclip MCP bridge only. */
  tools?: readonly Readonly<Record<string, unknown>>[];
  providerPolicy?: AcpxProviderRuntimePolicy;
}): Promise<AcpxRuntimeSandbox> {
  if (input.agent === "pi" && (input.providerPolicy === undefined || typeof input.providerPolicy.readOnly !== "boolean")) {
    throw new Error("Pi admission requires an explicit task execution policy");
  }
  const policy = await validateProviderPolicy(input.providerPolicy);
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
  const protectedPaths = Object.freeze([...new Set([physicalRuntimeDirectory, ...policy.protectedPaths])]);
  const workspaceRecordPath = join(root, "workspace");
  await writePrivateFile(
    workspaceRecordPath,
    `${input.binding.workspacePath}\n`,
  );
  if (input.agent === "claude") {
    // ACP otherwise rewrites exact IDs (including user-entered model IDs) to
    // picker aliases such as "sonnet". Its supported availableModels setting
    // preserves our requested ID through selection and model verification.
    await writePrivateFile(
      join(agentHomeDirectory, "settings.json"),
      `${JSON.stringify({
        model: input.binding.requestedModel,
        availableModels: [input.binding.requestedModel],
        ...((input.binding.permissionMode === "approve-reads" || input.binding.permissionMode === "approve-paperclip")
          ? { permissions: { allow: claudePaperclipPermissionRules(input.tools ?? [], input.binding.permissionMode) } }
          : {}),
      })}\n`,
    );
  }
  if (input.agent === "grok") {
    // Native project rules merge with global rules. Ask rules win over project
    // allows, keeping operation approval at the runner's authenticated boundary.
    await writePrivateFile(join(agentHomeDirectory, "config.toml"), [
      "[permission]",
      'ask = ["Bash", "Read", "Edit", "Grep", "MCPTool", "WebFetch", "WebSearch"]',
      "[ui]", 'permission_mode = "ask"',
      "[compat.claude]", "hooks = false", "mcps = false",
      "[compat.cursor]", "hooks = false", "mcps = false",
      "[managed_mcps]", "enabled = false", "gateway_tools_enabled = false",
      "[toolset.bash]", "login_shell_capture = false",
      "[shell_environment_policy]", 'exclude = ["XAI_API_KEY"]',
      "[subagents]", "enabled = false",
      "[workflows]", "enabled = false",
      "[goal]", "enabled = false", "",
    ].join("\n"));
    // Always-approve may otherwise be enabled by compatible project settings.
    // Even approve-all runs use one host decision per requested operation.
    await writePrivateFile(join(agentHomeDirectory, "requirements.toml"),
      "[ui]\ndisable_bypass_permissions_mode = true\n");
  }
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
  if (input.agent === "copilot") {
    await writePrivateFile(join(agentHomeDirectory, "config.json"), `${JSON.stringify({
      autoUpdate: false,
      trustedFolders: [],
      disableAllHooks: true,
      memory: false,
      ide: { autoConnect: false, openDiffOnEdit: false },
    })}\n`);
  }
  if (input.agent === "codex") {
    await writePrivateFile(
      join(agentHomeDirectory, "config.toml"),
      [
        // Codex shell snapshots serialize the provider process environment.
        // The ACPX sidecar receives a short-lived managed credential only so
        // it can authenticate the provider; that value must never become
        // durable runtime state. Keep this identical to the proven native
        // Codex isolation policy: broader shell-environment filtering can
        // also affect provider startup and belongs at the launch boundary.
        "[features]",
        "shell_snapshot = false",
        ...(input.environment?.PAPERCLIP_AGENT_KEY_ID ? [
          "[shell_environment_policy]", 'inherit = "all"', "ignore_default_excludes = true",
          `include_only = ${JSON.stringify([...new Set([
            "PATH", "HOME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "CODEX_HOME",
            "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY",
            // Provider/config secrets keep Codex's default shell exclusions;
            // only Paperclip's scoped API token is required by Bash/curl skills.
            ...Object.keys(input.environment).filter(key => key === "PAPERCLIP_API_KEY" || !/key|secret|token/i.test(key)),
          ])])}`,
        ] : []),
        "",
      ].join("\n"),
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
    ...(input.agent === "grok" ? { GROK_HOME: agentHomeDirectory, NO_BROWSER: "1", GROK_DISABLE_AUTOUPDATER: "1" } : {}),
    ...(input.agent === "pi"
      ? {
          PI_CODING_AGENT_DIR: agentHomeDirectory,
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          PAPERCLIP_PI_READ_ONLY: policy.readOnly ? "1" : "0",
          PAPERCLIP_PI_READ_ROOTS: JSON.stringify(policy.readRoots),
          PAPERCLIP_PI_PROTECTED_ROOTS: JSON.stringify(protectedPaths),
          PAPERCLIP_PI_SYSTEM_INSTRUCTIONS: policy.systemInstructions,
        }
      : {}),
    ...(input.agent === "cursor"
      ? {
          CURSOR_CONFIG_DIR: agentHomeDirectory,
          CURSOR_DATA_DIR: dataDirectory,
          AGENT_CLI_CREDENTIAL_STORE: "memory",
          NO_OPEN_BROWSER: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
        }
      : {}),
    ...(input.agent === "copilot"
      ? {
          COPILOT_HOME: agentHomeDirectory,
          COPILOT_CACHE_HOME: cacheDirectory,
          COPILOT_AUTO_UPDATE: "false",
          COPILOT_ALLOW_ALL: "false",
          COPILOT_DISABLE_TERMINAL_TITLE: "true",
          NO_COLOR: "1",
          // COPILOT_PKG_CACHE_HOME belongs to the per-spawn immutable command
          // lease. Reusing a persistent extraction cache invalidates its proof.
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
    protectedPaths,
    launchEnvironment: Object.freeze({ ...launchEnvironment }),
    persistedEnvironment: Object.freeze(persistedEnvironment),
  };
}

async function validateProviderPolicy(policy: AcpxProviderRuntimePolicy | undefined): Promise<{
  readOnly: boolean; readRoots: string[]; protectedPaths: string[]; systemInstructions: string;
}> {
  if (policy !== undefined && typeof policy.readOnly !== "boolean") throw new Error("Provider task execution policy is invalid");
  const paths = async (values: readonly string[] | undefined, requireExisting: boolean): Promise<string[]> => {
    if (values !== undefined && (!Array.isArray(values) || values.length > 128)) throw new Error("Provider runtime paths are invalid");
    return await Promise.all((values ?? []).map(async (value) => {
      if (typeof value !== "string" || !isAbsolute(value) || value === dirname(value) || /[\0\r\n]/.test(value)) throw new Error("Provider runtime path is invalid");
      const normalized = resolve(value);
      return requireExisting ? await realpath(normalized) : normalized;
    }));
  };
  const systemInstructions = policy?.systemInstructions ?? "";
  if (typeof systemInstructions !== "string" || systemInstructions.includes("\0") || Buffer.byteLength(systemInstructions) > 32 * 1024) throw new Error("Provider runtime instructions exceed their bounded size");
  return {
    readOnly: policy?.readOnly ?? true,
    readRoots: await paths(policy?.readRoots, true),
    protectedPaths: await paths(policy?.protectedPaths, false),
    systemInstructions,
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
    /^(?:CURSOR_CONFIG_DIR|CURSOR_DATA_DIR|AGENT_CLI_CREDENTIAL_STORE|NO_OPEN_BROWSER|NODE_DISABLE_COMPILE_CACHE)$/.test(name) ||
    /^(?:COPILOT_HOME|COPILOT_CACHE_HOME|COPILOT_AUTO_UPDATE|COPILOT_ALLOW_ALL|COPILOT_DISABLE_TERMINAL_TITLE|NO_COLOR)$/.test(name) ||
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
