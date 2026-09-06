import { createHash } from "node:crypto";
import {
  spawn as spawnChildProcess,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { constants, realpathSync } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Readable, Writable } from "node:stream";

import type { QualifiedAcpxProfile } from "./qualified-profiles.js";
import {
  VERIFIED_RUNTIME_EXECUTABLE_ENV,
  verifiedRuntimeExecutableHandoff,
} from "./verified-runtime-executable.js";

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_AGENT_COMMAND_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_EXECUTABLE_BYTES = 384 * 1024 * 1024;
const COMMAND_SOURCE_FD = 3;
const COMMAND_DIRECTORY_FD = 4;
const DEPENDENCY_ANCESTOR_FD_START = 5;
const MAX_DEPENDENCY_ANCESTORS = 64;
const PROVIDER_WATCHDOG_HANDSHAKE_TIMEOUT_MS = 2_000;
const PROVIDER_GUARDIAN_HANDSHAKE_TIMEOUT_MS = 5_000;
const VERIFIED_PROVIDER_RUNTIME_TARGET_ENV =
  "PAPERCLIP_ACPX_VERIFIED_PROVIDER_RUNTIME_TARGET";

const QUALIFIED_CLAUDE_LINUX_X64_RUNTIME = Object.freeze({
  runtimePackageName: "@anthropic-ai/claude-agent-sdk",
  runtimePackageVersion: "0.3.232",
  packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
  packageVersion: "0.3.232",
  dependencyDeclaration: "0.3.232",
  relativeExecutable: "claude",
  executableDigest:
    "sha256:61d23f8749136907d586d5b11831ea8a5234d4c1dea40a5e55c33b52e204c6d1",
  environmentVariable: "CLAUDE_CODE_EXECUTABLE",
});

const QUALIFIED_CODEX_LINUX_X64_RUNTIME = Object.freeze({
  runtimePackageName: "@openai/codex",
  runtimePackageVersion: "0.148.0",
  packageName: "@openai/codex-linux-x64",
  packageVersion: "0.148.0-linux-x64",
  dependencyDeclaration: "npm:@openai/codex@0.148.0-linux-x64",
  relativeExecutable: "vendor/x86_64-unknown-linux-musl/bin/codex",
  executableDigest:
    "sha256:ac2cfed85fb647d61e0150b8548102b330e4799d9d81ad5d354de701edf6b074",
  environmentVariable: "CODEX_PATH",
});

// Claude's ACP server is not a self-contained bundle: its entrypoint imports
// these three packages directly from pnpm's real store paths. Keep that exact
// package graph version-bound and descriptor-pinned instead of granting the
// provider ambient access to the workspace's complete node_modules ancestry.
const QUALIFIED_CLAUDE_PROVIDER_DEPENDENCIES = Object.freeze([
  Object.freeze({
    packageName: "@agentclientprotocol/sdk",
    packageVersion: "1.3.0",
    dependencyDeclaration: "1.3.0",
  }),
  Object.freeze({
    packageName: "@anthropic-ai/claude-agent-sdk",
    packageVersion: "0.3.232",
    dependencyDeclaration: "0.3.232",
  }),
  Object.freeze({
    packageName: "zod",
    packageVersion: "4.4.3",
    dependencyDeclaration: "^3.25.0 || ^4.0.0",
  }),
]);

const PROVIDER_LIFETIME_WATCHDOG_SOURCE = `
const fs = require("node:fs");
let reaped = false;
const reap = () => {
  if (reaped) return;
  reaped = true;
  try {
    // Resolve the watchdog's current group at signal-delivery time. The live
    // watchdog itself pins that identity until this atomic reap.
    process.kill(0, "SIGKILL");
  } catch {
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }
};
const owner = fs.createReadStream("", { fd: 3, autoClose: false });
owner.once("end", reap);
owner.once("error", reap);
owner.resume();
try {
  fs.writeSync(4, "armed\\n");
} catch {
  reap();
}
`;

export const PROVIDER_LIFETIME_GUARDIAN_SOURCE = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const WATCHDOG_SOURCE = ${JSON.stringify(PROVIDER_LIFETIME_WATCHDOG_SOURCE)};
const runtimeExecutable = process.env.${VERIFIED_RUNTIME_EXECUTABLE_ENV} || process.execPath;
const dependencyAncestorCount = Number.parseInt(process.argv[4], 10);
const providerRuntimeExecutableCount = Number.parseInt(process.argv[8], 10);
if (!Number.isSafeInteger(dependencyAncestorCount) || dependencyAncestorCount < 0 || dependencyAncestorCount > ${MAX_DEPENDENCY_ANCESTORS}) throw new Error("ACPX provider dependency ancestry is invalid");
if (providerRuntimeExecutableCount !== 0 && providerRuntimeExecutableCount !== 1) throw new Error("ACPX provider runtime executable count is invalid");
const PROVIDER_RUNTIME_EXECUTABLE_FD = ${DEPENDENCY_ANCESTOR_FD_START} + dependencyAncestorCount;
const OWNER_FD = PROVIDER_RUNTIME_EXECUTABLE_FD + providerRuntimeExecutableCount;
const OWNERSHIP_FD = OWNER_FD + 1;
const PROVIDER_EXIT_FD = OWNERSHIP_FD + 1;
const CREDENTIAL_FENCE_FD_START = PROVIDER_EXIT_FD + 1;
const VERIFIED_RUNTIME_FD = CREDENTIAL_FENCE_FD_START + 2;
const dependencyAncestorFds = Array.from({ length: dependencyAncestorCount }, (_, index) => ${DEPENDENCY_ANCESTOR_FD_START} + index);
const runtimeDescriptorMatch = /^\\/proc\\/self\\/fd\\/([0-9]+)$/.exec(runtimeExecutable);
const runtimeDescriptorFd = runtimeDescriptorMatch === null ? null : Number.parseInt(runtimeDescriptorMatch[1], 10);
if (runtimeDescriptorFd !== null && runtimeDescriptorFd !== VERIFIED_RUNTIME_FD) throw new Error("ACPX verified runtime descriptor is misplaced");
if (runtimeDescriptorFd !== null) fs.fstatSync(runtimeDescriptorFd);
let provider;
let watchdog;
let reaped = false;
let shutdownStarted = false;
const reap = () => {
  if (reaped) return;
  reaped = true;
  // This sentinel is the provider group's leader. It remains alive until this
  // one atomic signal, pinning the numeric group identity against PID reuse.
  process.kill(-process.pid, "SIGKILL");
};
const owner = fs.createReadStream("", { fd: OWNER_FD, autoClose: false });
owner.once("end", reap);
owner.once("error", reap);
owner.resume();
// Fail before provider code exists unless both inherited quorum fences are live.
fs.fstatSync(CREDENTIAL_FENCE_FD_START);
fs.fstatSync(CREDENTIAL_FENCE_FD_START + 1);
const shutdown = () => {
  if (shutdownStarted || reaped) return;
  shutdownStarted = true;
  try {
    provider?.kill("SIGTERM");
  } catch {
    reap();
    return;
  }
  setTimeout(reap, 1_000);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
const startProvider = () => {
  if (provider || reaped || shutdownStarted) return;
  try {
    provider = spawn(
      runtimeExecutable,
      ["--eval", process.argv[1], ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        detached: false,
        env: process.env,
        shell: false,
        // The provider observes this guardian-owned pipe directly. Kernel EOF
        // therefore revokes it even when SIGKILL/OOM prevents our JS reap path.
        // It also inherits both quorum fences until that self-reap completes.
        stdio: [0, 1, 2, ${COMMAND_SOURCE_FD}, ${COMMAND_DIRECTORY_FD}, ...dependencyAncestorFds, ...(providerRuntimeExecutableCount === 1 ? [PROVIDER_RUNTIME_EXECUTABLE_FD] : []), "pipe", PROVIDER_EXIT_FD, CREDENTIAL_FENCE_FD_START, CREDENTIAL_FENCE_FD_START + 1, ...(runtimeDescriptorFd === null ? [] : ["ignore", runtimeDescriptorFd])],
        windowsHide: true,
      },
    );
    provider.once("error", reap);
    provider.once("exit", reap);
    provider.once("spawn", () => {
      try {
        if (reaped || shutdownStarted) {
          reap();
          return;
        }
        // The provider now owns the only child-side copy. Parent-side EOF is an
        // independent kernel observation of provider exit even if this guardian
        // is killed before it can reap the group.
        fs.closeSync(PROVIDER_EXIT_FD);
        fs.writeSync(OWNERSHIP_FD, "owned\\n");
      } catch {
        reap();
      }
    });
  } catch {
    reap();
  }
};
try {
  // A credential-free peer in this same process group reaps the group through
  // its live identity if this guardian is killed before it can run its reap.
  // Its private owner pipe reaches kernel EOF on guardian death even while the
  // provider is stopped and unable to process its own guardian-loss callback.
  const watchdogStdio = ["ignore", "ignore", "ignore", "pipe", "pipe"];
  if (runtimeDescriptorFd !== null) {
    while (watchdogStdio.length < runtimeDescriptorFd) watchdogStdio.push("ignore");
    watchdogStdio.push(runtimeDescriptorFd);
  }
  watchdog = spawn(runtimeExecutable, ["--eval", WATCHDOG_SOURCE], {
    cwd: process.cwd(),
    detached: false,
    env: {},
    shell: false,
    stdio: watchdogStdio,
    windowsHide: true,
  });
  const watchdogOwnerPipe = watchdog.stdio[3];
  const watchdogReady = watchdog.stdio[4];
  if (watchdogOwnerPipe == null) throw new Error("ACPX provider lifetime watchdog omitted its owner pipe");
  if (watchdogReady == null) throw new Error("ACPX provider lifetime watchdog omitted its readiness pipe");
  watchdogOwnerPipe.once("error", reap);
  watchdog.once("error", reap);
  watchdog.once("exit", reap);
  let watchdogOutput = "";
  let watchdogArmed = false;
  const watchdogReadyTimeout = setTimeout(reap, ${PROVIDER_WATCHDOG_HANDSHAKE_TIMEOUT_MS});
  watchdogReadyTimeout.unref();
  const rejectUnarmedWatchdog = () => {
    if (!watchdogArmed) reap();
  };
  watchdogReady.once("error", rejectUnarmedWatchdog);
  watchdogReady.once("close", rejectUnarmedWatchdog);
  watchdogReady.on("data", (chunk) => {
    watchdogOutput += chunk.toString();
    if (watchdogOutput.length > 64) {
      reap();
      return;
    }
    if (!watchdogOutput.includes("armed\\n")) return;
    watchdogArmed = true;
    clearTimeout(watchdogReadyTimeout);
    watchdogReady.removeAllListeners("data");
    startProvider();
  });
} catch {
  reap();
}
`;

const providerGuardianOwnership = new WeakMap<ChildProcess, Promise<void>>();
const providerExitProof = new WeakMap<ChildProcess, Promise<void>>();

export type AcpxPackageJsonResolver = (
  packageName: string,
  issuerPackageJsonPath?: string,
) => string;

export function createAcpxPackageJsonResolver(
  providerPackageRoot: string | undefined,
  providerPackageManifest?: string,
): AcpxPackageJsonResolver {
  const root = providerPackageRoot?.trim();
  if (
    !root ||
    !isAbsolute(root) ||
    root.includes("\0") ||
    resolve(root) !== root
  ) {
    throw new Error(
      "ACPX provider package root must be an explicit normalized absolute path",
    );
  }
  const manifest = (
    providerPackageManifest ?? resolve(root, "package.json")
  ).trim();
  if (
    !manifest ||
    !isAbsolute(manifest) ||
    manifest.includes("\0") ||
    resolve(manifest) !== manifest
  ) {
    throw new Error(
      "ACPX provider package manifest must be an explicit normalized absolute path",
    );
  }
  const canonicalRoot = realpathSync(root);
  const canonicalManifest = realpathSync(manifest);
  if (!pathIsInside(canonicalRoot, canonicalManifest)) {
    throw new Error(
      "ACPX provider package manifest resolves outside the selected provider root",
    );
  }
  const canonicalNodeModules = realpathSync(
    resolve(canonicalRoot, "node_modules"),
  );
  if (!pathIsInside(canonicalRoot, canonicalNodeModules)) {
    throw new Error(
      "ACPX provider node_modules resolves outside the selected provider root",
    );
  }
  return (packageName, issuerPackageJsonPath) => {
    const canonicalIssuer =
      issuerPackageJsonPath === undefined
        ? canonicalManifest
        : realpathSync(issuerPackageJsonPath);
    if (!pathIsInside(canonicalRoot, canonicalIssuer)) {
      throw new Error(
        `ACPX provider package issuer for ${packageName} resolves outside the selected provider root`,
      );
    }
    const packageJsonPath = realpathSync(
      resolvePackageJsonFromIssuer(packageName, canonicalIssuer),
    );
    if (!pathIsInside(canonicalNodeModules, packageJsonPath)) {
      throw new Error(
        `ACPX provider package ${packageName} resolves outside the selected provider root`,
      );
    }
    return packageJsonPath;
  };
}

function resolvePackageJsonFromIssuer(
  packageName: string,
  issuerPackageJsonPath: string,
): string {
  const issuerRequire = createRequire(issuerPackageJsonPath);
  try {
    return issuerRequire.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
    )
      throw error;
  }

  const packageSegments = packageName.split("/");
  if (
    packageSegments.length < 1 ||
    packageSegments.length > 2 ||
    packageSegments.some((segment) => segment.length === 0)
  ) {
    throw new Error(`ACPX provider package name is invalid: ${packageName}`);
  }
  let directory = dirname(realpathSync(issuerRequire.resolve(packageName)));
  for (let count = 0; count < MAX_DEPENDENCY_ANCESTORS; count += 1) {
    const matchesPackage =
      basename(directory) === packageSegments.at(-1) &&
      (packageSegments.length === 1 ||
        basename(dirname(directory)) === packageSegments[0]);
    if (matchesPackage) return resolve(directory, "package.json");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `ACPX provider package manifest could not be located for ${packageName}`,
  );
}

function pathIsInside(root: string, candidate: string): boolean {
  const candidateRelativePath = relative(root, candidate);
  return (
    candidateRelativePath !== "" &&
    candidateRelativePath !== ".." &&
    !candidateRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(candidateRelativePath)
  );
}

export interface VerifiedAcpxInstallation {
  readonly commandDigest: string;
  readonly agentServerPackageJsonPath: string;
  readonly agentRuntimePackageJsonPath: string | null;
  openCommand(): Promise<VerifiedAcpxCommandLease>;
}

export interface VerifiedAcpxCommandLease {
  /**
   * Launch with a Linux descriptor-backed entry identity. Callers must not
   * admit a provider that requires its mutable installation pathname; that
   * compatibility belongs to the later provider-specific adapter gate.
   */
  spawn(
    args?: readonly string[],
    options?: SpawnOptionsWithoutStdio,
    lifetime?: VerifiedAcpxProviderLifetime,
  ): ChildProcess;
  close(): Promise<void>;
}

export interface VerifiedAcpxProviderLifetime {
  /** Two listening sockets that fence the canonical Codex credential home. */
  credentialFenceFds: readonly [number, number];
  /** Validate the guardian before provider admission can succeed. */
  activateCredentialFenceOwner(pid: number): Promise<void>;
}

/** Fail closed where verified provider-group ownership cannot be guaranteed. */
export function assertVerifiedAcpxProviderPlatform(
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    throw new Error(
      "The production ACPX runtime is unavailable on Windows because verified provider launch requires atomic no-follow file opening",
    );
  }
}

/** Reap only the group the live provider belongs to at signal-delivery time. */
export function reapCurrentProviderProcessGroup(
  kill: (pid: number, signal: NodeJS.Signals) => unknown,
  currentPid: number,
  exit: (code: number) => unknown,
): void {
  try {
    // POSIX pid zero names the caller's current process group. Unlike a saved
    // guardian PGID, the kernel resolves this ownership at the instant of the
    // signal, so a dead guardian's recycled identifier can never be targeted.
    kill(0, "SIGKILL");
  } catch {
    try {
      // The caller's own live PID cannot be recycled out from under it. This
      // fallback still revokes the provider if whole-group signaling fails.
      kill(currentPid, "SIGKILL");
    } catch {
      exit(1);
    }
  }
}

/** Wait until the verified wrapper has armed owner-death and credential fencing. */
export async function awaitVerifiedAcpxProviderOwnership(
  child: ChildProcess,
): Promise<void> {
  await (providerGuardianOwnership.get(child) ?? Promise.resolve());
}

/** Wait for kernel EOF on the descriptor held only by the provider process. */
export async function awaitVerifiedAcpxProviderExit(
  child: ChildProcess,
): Promise<void> {
  const exitProof = providerExitProof.get(child);
  if (!exitProof) {
    throw new Error("ACPX provider exit proof is unavailable");
  }
  await exitProof;
}

interface VerifiedAcpxCommandIdentity {
  device: string;
  inode: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
}

interface VerifiedAcpxRuntimeExecutable {
  path: string;
  digest: string;
  identity: VerifiedAcpxCommandIdentity;
  environmentVariable: "CLAUDE_CODE_EXECUTABLE" | "CODEX_PATH";
}

interface AcpxPackageMetadata {
  version?: string;
  bin?: unknown;
  type?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
}

interface VerifiedAcpxDirectoryIdentity {
  device: string;
  inode: string;
}

interface VerifiedAcpxDependencyAncestor {
  path: string;
  identity: VerifiedAcpxDirectoryIdentity;
}

type AcpxCommandFormat = "commonjs" | "module";

const COMMONJS_SNAPSHOT_BOOTSTRAP = snapshotBootstrap("commonjs");
const MODULE_SNAPSHOT_BOOTSTRAP = snapshotBootstrap("module");
const GUARDED_COMMONJS_SNAPSHOT_BOOTSTRAP = snapshotBootstrap("commonjs", true);
const GUARDED_MODULE_SNAPSHOT_BOOTSTRAP = snapshotBootstrap("module", true);

/** Resolve and verify every installed artifact bound by a qualified profile. */
export async function verifyQualifiedAcpxInstallation(
  profile: QualifiedAcpxProfile,
  resolvePackageJson: AcpxPackageJsonResolver = defaultPackageJsonResolver,
): Promise<VerifiedAcpxInstallation> {
  const serverPackageJsonPath = await realpath(
    resolvePackageJson(profile.agentServerPackage),
  );
  const serverPackage = await readPackageJson(
    serverPackageJsonPath,
    profile.agentServerPackage,
  );
  if (serverPackage.version !== profile.agentServerVersion) {
    throw new Error(
      `ACPX ${profile.agent} package version mismatch: expected ${profile.agentServerVersion}, received ${serverPackage.version ?? "unknown"}`,
    );
  }
  const relativeCommand = oneExecutable(serverPackage.bin, profile.agent);
  const commandFormat = executableFormat(
    relativeCommand,
    serverPackage.type,
    profile.agent,
  );
  const serverPackageFormat = packageModuleFormat(serverPackage.type);
  const packageDirectory = dirname(serverPackageJsonPath);
  const unresolvedCommandPath = resolve(packageDirectory, relativeCommand);
  if (!isInside(packageDirectory, unresolvedCommandPath)) {
    throw new Error(`ACPX ${profile.agent} executable escapes its package`);
  }
  const commandDirectory = await realpath(dirname(unresolvedCommandPath));
  if (!isInsideOrEqual(packageDirectory, commandDirectory)) {
    throw new Error(`ACPX ${profile.agent} executable escapes its package`);
  }
  const commandPath = resolve(
    commandDirectory,
    basename(unresolvedCommandPath),
  );
  const verifiedDirectory = await openVerifiedCommandDirectory(
    commandDirectory,
    profile.agent,
  );
  const commandDirectoryIdentity = verifiedDirectory.identity;
  await verifiedDirectory.handle.close();
  const command = await inspectCommand(
    commandPath,
    profile.commandDigest,
    profile.agent,
  );

  let runtimePackageJsonPath: string | null = null;
  let runtimePackageFormat: AcpxCommandFormat | null = null;
  let runtimePackage: AcpxPackageMetadata | null = null;
  let runtimeExecutable: VerifiedAcpxRuntimeExecutable | null = null;
  if (profile.agentRuntimePackage !== null) {
    if (profile.agentRuntimeVersion === null) {
      throw new Error("Qualified ACPX runtime package omitted its version");
    }
    runtimePackageJsonPath = await realpath(
      resolvePackageJson(profile.agentRuntimePackage, serverPackageJsonPath),
    );
    runtimePackage = await readPackageJson(
      runtimePackageJsonPath,
      profile.agentRuntimePackage,
    );
    if (runtimePackage.version !== profile.agentRuntimeVersion) {
      throw new Error(
        `ACPX ${profile.agent} runtime version mismatch: expected ${profile.agentRuntimeVersion}, received ${runtimePackage.version ?? "unknown"}`,
      );
    }
    runtimePackageFormat = packageModuleFormat(runtimePackage.type);
    runtimeExecutable = await verifyQualifiedRuntimeExecutable({
      profile,
      runtimePackage,
      runtimePackageJsonPath,
      resolvePackageJson,
    });
  } else if (profile.agentRuntimeVersion !== null) {
    throw new Error("Qualified ACPX runtime version omitted its package");
  }

  const supplementalPackages: Array<{
    directory: string;
    format: AcpxCommandFormat;
  }> = [];
  if (profile.agent === "claude") {
    const declaredDependencies = serverPackage.dependencies;
    if (
      typeof declaredDependencies !== "object" ||
      declaredDependencies === null ||
      Array.isArray(declaredDependencies)
    ) {
      throw new Error("ACPX claude package omitted its qualified dependencies");
    }
    for (const expected of QUALIFIED_CLAUDE_PROVIDER_DEPENDENCIES) {
      if (
        (declaredDependencies as Record<string, unknown>)[
          expected.packageName
        ] !== expected.dependencyDeclaration
      ) {
        throw new Error(
          `ACPX claude package dependency mismatch for ${expected.packageName}`,
        );
      }
      const dependencyPackageJsonPath = await realpath(
        resolvePackageJson(expected.packageName, serverPackageJsonPath),
      );
      const dependencyPackage = await readPackageJson(
        dependencyPackageJsonPath,
        expected.packageName,
      );
      if (dependencyPackage.version !== expected.packageVersion) {
        throw new Error(
          `ACPX claude dependency package version mismatch for ${expected.packageName}: expected ${expected.packageVersion}, received ${dependencyPackage.version ?? "unknown"}`,
        );
      }
      supplementalPackages.push({
        directory: dirname(dependencyPackageJsonPath),
        format: packageModuleFormat(dependencyPackage.type),
      });
    }
  }

  const serverDependencyAncestors = await inspectDependencyAncestors(
    commandDirectory,
    packageDirectory,
    profile.agent,
  );
  const dependencyAncestors = [...serverDependencyAncestors];
  const dependencyAncestorFormats = serverDependencyAncestors.map(
    () => serverPackageFormat,
  );
  if (runtimePackageJsonPath !== null) {
    const runtimeDirectory = dirname(runtimePackageJsonPath);
    // A separately qualified runtime is an explicit trust root. We do not
    // retain arbitrary package-manager ancestors: hoisted dependencies must
    // be qualified by a provider-specific layer instead of becoming ambient
    // executable authority here.
    if (
      runtimeDirectory !== commandDirectory &&
      !dependencyAncestors.some(
        (ancestor) => ancestor.path === runtimeDirectory,
      )
    ) {
      dependencyAncestors.push(
        await inspectExplicitDependencyRoot(
          runtimeDirectory,
          `${profile.agent} runtime`,
        ),
      );
      dependencyAncestorFormats.push(runtimePackageFormat ?? "commonjs");
    }
  }
  for (const supplemental of supplementalPackages) {
    if (
      supplemental.directory !== commandDirectory &&
      !dependencyAncestors.some(
        (ancestor) => ancestor.path === supplemental.directory,
      )
    ) {
      dependencyAncestors.push(
        await inspectExplicitDependencyRoot(
          supplemental.directory,
          `${profile.agent} dependency`,
        ),
      );
      dependencyAncestorFormats.push(supplemental.format);
    }
  }
  if (dependencyAncestors.length > MAX_DEPENDENCY_ANCESTORS) {
    throw new Error("ACPX provider dependency ancestry exceeds its bound");
  }
  const serverDependencyAncestorCount = serverDependencyAncestors.length;

  const commandDigest = command.digest;
  const commandIdentity = command.identity;
  return Object.freeze({
    commandDigest,
    agentServerPackageJsonPath: serverPackageJsonPath,
    agentRuntimePackageJsonPath: runtimePackageJsonPath,
    async openCommand(): Promise<VerifiedAcpxCommandLease> {
      const currentDirectory = await openVerifiedCommandDirectory(
        commandDirectory,
        "provider",
      );
      if (
        !sameDirectoryIdentity(
          currentDirectory.identity,
          commandDirectoryIdentity,
        )
      ) {
        await currentDirectory.handle.close();
        throw new Error(
          "ACPX provider executable directory identity changed after verification",
        );
      }
      let currentDependencyAncestors: FileHandle[] = [];
      let currentRuntimeExecutable: FileHandle | null = null;
      try {
        currentDependencyAncestors =
          await openDependencyAncestors(dependencyAncestors);
        if (runtimeExecutable !== null) {
          const current = await openVerifiedRuntimeExecutable(
            runtimeExecutable.path,
            runtimeExecutable.digest,
            profile.agent,
          );
          if (!sameIdentity(current.identity, runtimeExecutable.identity)) {
            await current.handle.close();
            throw new Error(
              "ACPX provider runtime executable identity changed after verification",
            );
          }
          currentRuntimeExecutable = current.handle;
        }
        const current = await inspectCommand(
          commandPath,
          commandDigest,
          "provider",
        );
        if (!sameIdentity(current.identity, commandIdentity)) {
          current.bytes.fill(0);
          throw new Error(
            "ACPX provider executable identity changed after verification",
          );
        }
        return commandLease(
          commandDirectory,
          basename(commandPath),
          commandFormat,
          current.bytes,
          currentDirectory.handle,
          currentDependencyAncestors,
          serverDependencyAncestorCount,
          serverPackageFormat,
          dependencyAncestorFormats,
          currentRuntimeExecutable,
          runtimeExecutable?.environmentVariable ?? null,
        );
      } catch (error) {
        await Promise.all([
          currentDirectory.handle.close(),
          ...currentDependencyAncestors.map((handle) => handle.close()),
          ...(currentRuntimeExecutable === null
            ? []
            : [currentRuntimeExecutable.close()]),
        ]);
        throw error;
      }
    },
  });
}

function defaultPackageJsonResolver(
  packageName: string,
  issuerPackageJsonPath?: string,
): string {
  const providerPackageRoot = process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT;
  if (providerPackageRoot !== undefined) {
    return createAcpxPackageJsonResolver(
      providerPackageRoot,
      process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST,
    )(packageName, issuerPackageJsonPath);
  }
  // Source-mode and direct runtimes still have a stable module URL. The
  // descriptor-backed runner sidecar always receives the explicit root above.
  return resolvePackageJsonFromIssuer(
    packageName,
    issuerPackageJsonPath ?? import.meta.url,
  );
}

async function readPackageJson(
  packageJsonPath: string,
  packageName: string,
): Promise<AcpxPackageMetadata> {
  const bytes = await readBoundedRegularFile(
    packageJsonPath,
    MAX_PACKAGE_JSON_BYTES,
    `${packageName} package.json`,
  );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`ACPX package ${packageName} has malformed package.json`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`ACPX package ${packageName} has invalid package metadata`);
  }
  return value as AcpxPackageMetadata;
}

async function verifyQualifiedRuntimeExecutable(input: {
  profile: QualifiedAcpxProfile;
  runtimePackage: AcpxPackageMetadata;
  runtimePackageJsonPath: string;
  resolvePackageJson: AcpxPackageJsonResolver;
}): Promise<VerifiedAcpxRuntimeExecutable | null> {
  const qualification =
    input.profile.agent === "claude"
      ? QUALIFIED_CLAUDE_LINUX_X64_RUNTIME
      : input.profile.agent === "codex"
        ? QUALIFIED_CODEX_LINUX_X64_RUNTIME
        : null;
  if (qualification === null) return null;
  if (
    input.profile.agentRuntimePackage !== qualification.runtimePackageName ||
    input.profile.agentRuntimeVersion !== qualification.runtimePackageVersion
  ) {
    throw new Error(
      `ACPX ${input.profile.agent} runtime does not match its qualified profile`,
    );
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `ACPX ${input.profile.agent} verified runtime executable requires qualified Linux x64`,
    );
  }

  const optionalDependencies = input.runtimePackage.optionalDependencies;
  if (
    typeof optionalDependencies !== "object" ||
    optionalDependencies === null ||
    Array.isArray(optionalDependencies) ||
    (optionalDependencies as Record<string, unknown>)[
      qualification.packageName
    ] !== qualification.dependencyDeclaration
  ) {
    throw new Error(
      `ACPX ${input.profile.agent} runtime omitted its qualified Linux executable package`,
    );
  }

  const executablePackageJsonPath = await realpath(
    input.resolvePackageJson(
      qualification.packageName,
      input.runtimePackageJsonPath,
    ),
  );
  const executablePackage = await readPackageJson(
    executablePackageJsonPath,
    qualification.packageName,
  );
  if (executablePackage.version !== qualification.packageVersion) {
    throw new Error(
      `ACPX ${input.profile.agent} runtime executable package version mismatch: expected ${qualification.packageVersion}, received ${executablePackage.version ?? "unknown"}`,
    );
  }

  const packageDirectory = dirname(executablePackageJsonPath);
  const unresolvedExecutablePath = resolve(
    packageDirectory,
    qualification.relativeExecutable,
  );
  if (!isInside(packageDirectory, unresolvedExecutablePath)) {
    throw new Error(
      `ACPX ${input.profile.agent} runtime executable escapes its package`,
    );
  }
  const executableDirectory = await realpath(dirname(unresolvedExecutablePath));
  if (!isInsideOrEqual(packageDirectory, executableDirectory)) {
    throw new Error(
      `ACPX ${input.profile.agent} runtime executable escapes its package`,
    );
  }
  const executablePath = resolve(
    executableDirectory,
    basename(unresolvedExecutablePath),
  );
  const verified = await openVerifiedRuntimeExecutable(
    executablePath,
    qualification.executableDigest,
    input.profile.agent,
  );
  await verified.handle.close();
  return {
    path: executablePath,
    digest: qualification.executableDigest,
    identity: verified.identity,
    environmentVariable: qualification.environmentVariable,
  };
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const bytes = await readFile(filePath);
  if (bytes.length < 1 || bytes.length > maxBytes) {
    throw new Error(`${label} changed outside its bounded size`);
  }
  return bytes;
}

async function inspectCommand(
  commandPath: string,
  expectedDigest: string,
  agent: string,
): Promise<{
  bytes: Buffer;
  digest: string;
  identity: VerifiedAcpxCommandIdentity;
}> {
  const lexicalBefore = await lstat(commandPath, { bigint: true }).catch(
    () => null,
  );
  if (
    lexicalBefore === null ||
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile()
  ) {
    throw new Error(`ACPX ${agent} executable must be a real regular file`);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      commandPath,
      verifiedExecutableOpenFlags(process.platform, constants.O_NOFOLLOW),
    );
  } catch {
    throw new Error(
      `ACPX ${agent} executable could not be opened as a no-follow regular file`,
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_AGENT_COMMAND_BYTES)
    ) {
      throw new Error(
        `ACPX ${agent} executable must be a bounded regular file`,
      );
    }
    const bytes = await readHandleAtStart(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    const lexicalAfter = await lstat(commandPath, { bigint: true }).catch(
      () => null,
    );
    const beforeIdentity = fileIdentity(before);
    const afterIdentity = fileIdentity(after);
    if (
      bytes.length < 1 ||
      bytes.length > MAX_AGENT_COMMAND_BYTES ||
      lexicalAfter === null ||
      lexicalAfter.isSymbolicLink() ||
      !lexicalAfter.isFile() ||
      !sameIdentity(fileIdentity(lexicalBefore), fileIdentity(lexicalAfter)) ||
      !sameIdentity(fileIdentity(lexicalAfter), afterIdentity) ||
      !sameIdentity(beforeIdentity, afterIdentity) ||
      after.size !== BigInt(bytes.length)
    ) {
      throw new Error(`ACPX ${agent} executable changed while it was verified`);
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== expectedDigest) {
      throw new Error(`ACPX ${agent} executable digest mismatch`);
    }
    return { bytes, digest, identity: afterIdentity };
  } catch (error) {
    throw error;
  } finally {
    await handle.close();
  }
}

async function openVerifiedRuntimeExecutable(
  executablePath: string,
  expectedDigest: string,
  agent: string,
): Promise<{ handle: FileHandle; identity: VerifiedAcpxCommandIdentity }> {
  const lexicalBefore = await lstat(executablePath, { bigint: true }).catch(
    () => null,
  );
  if (
    lexicalBefore === null ||
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile()
  ) {
    throw new Error(
      `ACPX ${agent} runtime executable must be a real regular file`,
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(
      executablePath,
      verifiedExecutableOpenFlags(process.platform, constants.O_NOFOLLOW),
    );
  } catch {
    throw new Error(
      `ACPX ${agent} runtime executable could not be opened as a no-follow regular file`,
    );
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_RUNTIME_EXECUTABLE_BYTES) ||
      (before.mode & 0o111n) === 0n
    ) {
      throw new Error(
        `ACPX ${agent} runtime executable must be a bounded executable file`,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    try {
      while (position < Number(before.size)) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - position),
          position,
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      buffer.fill(0);
    }
    const after = await handle.stat({ bigint: true });
    const lexicalAfter = await lstat(executablePath, { bigint: true }).catch(
      () => null,
    );
    const beforeIdentity = fileIdentity(before);
    const afterIdentity = fileIdentity(after);
    if (
      position !== Number(before.size) ||
      lexicalAfter === null ||
      lexicalAfter.isSymbolicLink() ||
      !lexicalAfter.isFile() ||
      !sameIdentity(fileIdentity(lexicalBefore), fileIdentity(lexicalAfter)) ||
      !sameIdentity(fileIdentity(lexicalAfter), afterIdentity) ||
      !sameIdentity(beforeIdentity, afterIdentity)
    ) {
      throw new Error(
        `ACPX ${agent} runtime executable changed while it was verified`,
      );
    }
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== expectedDigest) {
      throw new Error(`ACPX ${agent} runtime executable digest mismatch`);
    }
    return { handle, identity: afterIdentity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Fail closed where Node cannot atomically refuse a final symlink component. */
export function verifiedExecutableOpenFlags(
  platform: NodeJS.Platform,
  noFollowFlag: number | undefined,
): number {
  if (
    platform === "win32" ||
    typeof noFollowFlag !== "number" ||
    noFollowFlag === 0
  ) {
    throw new Error(
      "ACPX verified executable launch requires atomic no-follow file opening",
    );
  }
  return constants.O_RDONLY | noFollowFlag;
}

async function openVerifiedCommandDirectory(
  commandDirectory: string,
  agent: string,
): Promise<{
  handle: FileHandle;
  identity: VerifiedAcpxDirectoryIdentity;
}> {
  const lexicalBefore = await lstat(commandDirectory, { bigint: true }).catch(
    () => null,
  );
  if (
    lexicalBefore === null ||
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isDirectory()
  ) {
    throw new Error(
      `ACPX ${agent} executable directory must be a real directory`,
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(
      commandDirectory,
      verifiedDirectoryOpenFlags(
        process.platform,
        constants.O_NOFOLLOW,
        constants.O_DIRECTORY,
      ),
    );
  } catch {
    throw new Error(
      `ACPX ${agent} executable directory could not be opened as a no-follow directory`,
    );
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const lexicalAfter = await lstat(commandDirectory, { bigint: true }).catch(
      () => null,
    );
    const beforeIdentity = directoryIdentity(lexicalBefore);
    const openedIdentity = directoryIdentity(opened);
    if (
      !opened.isDirectory() ||
      lexicalAfter === null ||
      lexicalAfter.isSymbolicLink() ||
      !lexicalAfter.isDirectory() ||
      !sameDirectoryIdentity(beforeIdentity, directoryIdentity(lexicalAfter)) ||
      !sameDirectoryIdentity(directoryIdentity(lexicalAfter), openedIdentity)
    ) {
      throw new Error(
        `ACPX ${agent} executable directory changed while it was verified`,
      );
    }
    return { handle, identity: openedIdentity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inspectDependencyAncestors(
  commandDirectory: string,
  packageDirectory: string,
  agent: string,
): Promise<VerifiedAcpxDependencyAncestor[]> {
  const ancestors: VerifiedAcpxDependencyAncestor[] = [];
  if (commandDirectory === packageDirectory) return ancestors;
  let ancestor = dirname(commandDirectory);
  for (let count = 0; count < MAX_DEPENDENCY_ANCESTORS; count += 1) {
    if (!isInsideOrEqual(packageDirectory, ancestor)) {
      throw new Error("ACPX provider dependency ancestry escaped its package");
    }
    const verified = await openVerifiedCommandDirectory(ancestor, agent);
    ancestors.push({ path: ancestor, identity: verified.identity });
    await verified.handle.close();
    if (ancestor === packageDirectory) return ancestors;
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error("ACPX provider dependency ancestry exceeds its bound");
}

async function openDependencyAncestors(
  ancestors: readonly VerifiedAcpxDependencyAncestor[],
): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  try {
    for (const expected of ancestors) {
      const current = await openVerifiedCommandDirectory(
        expected.path,
        "provider dependency ancestor",
      );
      if (!sameDirectoryIdentity(current.identity, expected.identity)) {
        await current.handle.close();
        throw new Error(
          "ACPX provider dependency ancestor identity changed after verification",
        );
      }
      handles.push(current.handle);
    }
    return handles;
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

async function inspectExplicitDependencyRoot(
  path: string,
  label: string,
): Promise<VerifiedAcpxDependencyAncestor> {
  const verified = await openVerifiedCommandDirectory(path, label);
  const ancestor = { path, identity: verified.identity };
  await verified.handle.close();
  return ancestor;
}

/** Fail closed where Node cannot atomically pin a real directory inode. */
function verifiedDirectoryOpenFlags(
  platform: NodeJS.Platform,
  noFollowFlag: number | undefined,
  directoryFlag: number | undefined,
): number {
  if (
    platform === "win32" ||
    typeof noFollowFlag !== "number" ||
    noFollowFlag === 0 ||
    typeof directoryFlag !== "number" ||
    directoryFlag === 0
  ) {
    throw new Error(
      "ACPX verified executable launch requires atomic no-follow directory opening",
    );
  }
  return constants.O_RDONLY | noFollowFlag | directoryFlag;
}

async function readHandleAtStart(
  handle: FileHandle,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset !== size) {
    throw new Error("ACPX provider executable ended during verification");
  }
  return bytes;
}

function commandLease(
  commandDirectoryPath: string,
  commandName: string,
  format: AcpxCommandFormat,
  verifiedBytes: Buffer,
  commandDirectory: FileHandle,
  dependencyAncestors: readonly FileHandle[],
  serverDependencyAncestorCount: number,
  serverPackageFormat: AcpxCommandFormat,
  dependencyAncestorFormats: readonly AcpxCommandFormat[],
  providerRuntimeExecutable: FileHandle | null,
  providerRuntimeEnvironmentVariable:
    VerifiedAcpxRuntimeExecutable["environmentVariable"] | null,
): VerifiedAcpxCommandLease {
  let consumed = false;
  let directoriesReleased = false;
  const releaseDirectories = async (): Promise<void> => {
    if (directoriesReleased) return;
    directoriesReleased = true;
    await Promise.all([
      commandDirectory.close(),
      ...dependencyAncestors.map((handle) => handle.close()),
      ...(providerRuntimeExecutable === null
        ? []
        : [providerRuntimeExecutable.close()]),
    ]);
  };
  const releaseDirectoriesBestEffort = (): void => {
    void releaseDirectories().catch(() => undefined);
  };
  const close = async (): Promise<void> => {
    if (consumed) return;
    consumed = true;
    verifiedBytes.fill(0);
    await releaseDirectories();
  };
  return {
    spawn(
      args: readonly string[] = [],
      options: SpawnOptionsWithoutStdio = {},
      lifetime?: VerifiedAcpxProviderLifetime,
    ): ChildProcess {
      if (consumed) throw new Error("Verified ACPX command lease is closed");
      consumed = true;
      let child: ChildProcess;
      try {
        const guarded = lifetime !== undefined;
        if (guarded) assertVerifiedAcpxProviderPlatform(process.platform);
        const providerBootstrap = guarded
          ? format === "module"
            ? GUARDED_MODULE_SNAPSHOT_BOOTSTRAP
            : GUARDED_COMMONJS_SNAPSHOT_BOOTSTRAP
          : format === "module"
            ? MODULE_SNAPSHOT_BOOTSTRAP
            : COMMONJS_SNAPSHOT_BOOTSTRAP;
        const providerRuntimeExecutableCount =
          providerRuntimeExecutable === null ? 0 : 1;
        const providerGuardianFd =
          DEPENDENCY_ANCESTOR_FD_START +
          dependencyAncestors.length +
          providerRuntimeExecutableCount;
        const providerOwnershipFd = providerGuardianFd + 1;
        const providerExitFd = providerOwnershipFd + 1;
        if (
          guarded &&
          (!Array.isArray(lifetime.credentialFenceFds) ||
            lifetime.credentialFenceFds.length !== 2 ||
            lifetime.credentialFenceFds.some(
              (fd) => !Number.isSafeInteger(fd) || fd < 0,
            ) ||
            lifetime.credentialFenceFds[0] === lifetime.credentialFenceFds[1] ||
            typeof lifetime.activateCredentialFenceOwner !== "function")
        ) {
          throw new Error("ACPX provider credential fence is invalid");
        }
        const runtimeTargetFd = guarded
          ? providerExitFd + 3
          : DEPENDENCY_ANCESTOR_FD_START +
            dependencyAncestors.length +
            providerRuntimeExecutableCount;
        const runtimeHandoff =
          verifiedRuntimeExecutableHandoff(runtimeTargetFd);
        const environment = sanitizedNodeEnvironment(options.env);
        if (runtimeHandoff.environmentValue === undefined) {
          delete environment[VERIFIED_RUNTIME_EXECUTABLE_ENV];
        } else {
          environment[VERIFIED_RUNTIME_EXECUTABLE_ENV] =
            runtimeHandoff.environmentValue;
        }
        if (
          (providerRuntimeExecutable === null) !==
          (providerRuntimeEnvironmentVariable === null)
        ) {
          throw new Error("ACPX provider runtime executable lease is invalid");
        }
        if (providerRuntimeEnvironmentVariable === null) {
          delete environment[VERIFIED_PROVIDER_RUNTIME_TARGET_ENV];
        } else {
          environment[VERIFIED_PROVIDER_RUNTIME_TARGET_ENV] =
            providerRuntimeEnvironmentVariable;
        }
        child = spawnChildProcess(
          runtimeHandoff.executable,
          guarded
            ? [
                // Keep resolved module URLs on the retained descriptor paths
                // so the hook can distinguish them from host ancestry.
                "--preserve-symlinks",
                "--eval",
                PROVIDER_LIFETIME_GUARDIAN_SOURCE,
                providerBootstrap,
                commandDirectoryPath,
                commandName,
                String(dependencyAncestors.length),
                String(serverDependencyAncestorCount),
                serverPackageFormat,
                JSON.stringify(dependencyAncestorFormats),
                String(providerRuntimeExecutableCount),
                ...args,
              ]
            : [
                "--preserve-symlinks",
                "--eval",
                providerBootstrap,
                commandDirectoryPath,
                commandName,
                String(dependencyAncestors.length),
                String(serverDependencyAncestorCount),
                serverPackageFormat,
                JSON.stringify(dependencyAncestorFormats),
                String(providerRuntimeExecutableCount),
                ...args,
              ],
          {
            ...options,
            // In production this process is a persistent sentinel and group
            // leader. It arms owner-death before spawning provider code, keeps
            // both credential quorum listeners inherited, and pins the PGID
            // until its single whole-group reap.
            detached: process.platform !== "win32",
            env: environment,
            shell: false,
            stdio: guarded
              ? [
                  "pipe",
                  "pipe",
                  "pipe",
                  "pipe",
                  commandDirectory.fd,
                  ...dependencyAncestors.map((handle) => handle.fd),
                  ...(providerRuntimeExecutable === null
                    ? []
                    : [providerRuntimeExecutable.fd]),
                  "pipe",
                  "pipe",
                  "pipe",
                  ...lifetime.credentialFenceFds,
                  ...(runtimeHandoff.sourceFd === null
                    ? []
                    : [runtimeHandoff.sourceFd]),
                ]
              : [
                  "pipe",
                  "pipe",
                  "pipe",
                  "pipe",
                  commandDirectory.fd,
                  ...dependencyAncestors.map((handle) => handle.fd),
                  ...(providerRuntimeExecutable === null
                    ? []
                    : [providerRuntimeExecutable.fd]),
                  ...(runtimeHandoff.sourceFd === null
                    ? []
                    : [runtimeHandoff.sourceFd]),
                ],
          },
        );
        if (guarded) {
          const guardianOwnerPipe = child.stdio[
            providerOwnershipFd - 1
          ] as Writable | null;
          if (guardianOwnerPipe === null) {
            throw new Error(
              "ACPX provider lifetime guardian omitted its owner pipe",
            );
          }
          protectProviderGroupKill(child, guardianOwnerPipe);
          const exitProof = providerExitHandshake(child, providerExitFd);
          void exitProof.catch(() => undefined);
          providerExitProof.set(child, exitProof);
          const guardianPid = child.pid!;
          const ownership = Promise.all([
            providerOwnershipHandshake(child, providerOwnershipFd),
            Promise.resolve().then(() =>
              lifetime.activateCredentialFenceOwner(guardianPid),
            ),
          ]).then(() => undefined);
          // Session construction can reject before the adapter reaches its
          // explicit ownership await. Observe that early rejection now while
          // preserving it for the admission boundary.
          void ownership.catch(() => undefined);
          providerGuardianOwnership.set(child, ownership);
        }
      } catch (error) {
        verifiedBytes.fill(0);
        releaseDirectoriesBestEffort();
        throw error;
      }
      releaseDirectoriesBestEffort();
      const sourceInput = child.stdio[COMMAND_SOURCE_FD] as Writable | null;
      if (sourceInput === null) {
        verifiedBytes.fill(0);
        child.kill();
        throw new Error("Verified ACPX command source pipe was not created");
      }
      const release = (): void => {
        verifiedBytes.fill(0);
      };
      sourceInput.once("error", release);
      sourceInput.end(verifiedBytes, release);
      return child;
    },
    close,
  };
}

function protectProviderGroupKill(
  child: ChildProcess,
  guardianOwnerPipe: Writable,
): void {
  const signalGuardian = child.kill.bind(child);
  let groupReaped = false;
  let revocationStarted = false;
  child.once("exit", () => {
    groupReaped = true;
  });
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (signal !== "SIGKILL" && signal !== 9) {
      return signalGuardian(signal);
    }
    if (groupReaped) return false;
    if (!revocationStarted) {
      revocationStarted = true;
      // Revocation closes the retained parent-to-guardian owner pipe. Resume
      // the exact direct child as well: SIGCONT is harmless for a running
      // guardian and lets a stopped guardian observe EOF and reap its own
      // still-pinned group. Do not mark the group reaped until exit is seen.
      guardianOwnerPipe.destroy();
    }
    try {
      // Every retry wakes the exact live guardian so it can observe the owner
      // pipe EOF and reap the whole group itself. Never SIGKILL the guardian:
      // a stopped real provider could otherwise survive after the adapter
      // forgets the only process that still pins its group identity.
      signalGuardian("SIGCONT");
    } catch {
      // The pipe close remains the primary revocation operation. Retained
      // cleanup keeps waiting for observed guardian exit and may retry wakeup.
    }
    return true;
  };
}

function providerOwnershipHandshake(
  child: ChildProcess,
  ownershipFd: number,
): Promise<void> {
  const output = (child.stdio as Array<Readable | Writable | null | undefined>)[
    ownershipFd
  ] as Readable | null | undefined;
  if (output == null) {
    return Promise.reject(
      new Error("ACPX provider lifetime guardian omitted its ownership pipe"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffered = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      output.off("data", onData);
      if (error) reject(error);
      else resolve();
    };
    const onError = (): void =>
      finish(new Error("ACPX provider lifetime guardian failed to start"));
    const onClose = (): void =>
      finish(
        new Error(
          "ACPX provider lifetime guardian exited before ownership transfer",
        ),
      );
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      if (buffered.includes("owned\n")) finish();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error("ACPX provider lifetime guardian ownership timed out"),
        ),
      PROVIDER_GUARDIAN_HANDSHAKE_TIMEOUT_MS,
    );
    timer.unref();
    child.once("error", onError);
    child.once("close", onClose);
    output.on("data", onData);
  });
}

function providerExitHandshake(
  child: ChildProcess,
  providerExitFd: number,
): Promise<void> {
  const output = (child.stdio as Array<Readable | Writable | null | undefined>)[
    providerExitFd
  ] as Readable | null | undefined;
  if (output == null) {
    return Promise.reject(
      new Error("ACPX provider lifetime proof pipe was not created"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      output.off("end", onEnd);
      output.off("close", onClose);
      output.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onEnd = (): void => finish();
    const onClose = (): void =>
      finish(
        output.readableEnded
          ? undefined
          : new Error("ACPX provider lifetime proof pipe closed before EOF"),
      );
    const onError = (): void =>
      finish(new Error("ACPX provider lifetime proof pipe failed"));
    output.once("end", onEnd);
    output.once("close", onClose);
    output.once("error", onError);
    output.resume();
  });
}

export function sanitizedNodeEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const sanitized = { ...(environment ?? process.env) };
  for (const key of Object.keys(sanitized)) {
    // Environment keys are case-insensitive on Windows. Dropping every case
    // variant also keeps a context portable instead of admitting a preload or
    // an unverified package-search root on one runner host but not another.
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey === "NODE_OPTIONS" ||
      normalizedKey === "NODE_PATH" ||
      normalizedKey === "GCONV_PATH" ||
      normalizedKey === "GLIBC_TUNABLES" ||
      normalizedKey === "OPENSSL_CONF" ||
      normalizedKey === "OPENSSL_ENGINES" ||
      normalizedKey === "OPENSSL_MODULES" ||
      normalizedKey.startsWith("LD_") ||
      normalizedKey.startsWith("DYLD_")
    ) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function snapshotBootstrap(format: AcpxCommandFormat, guarded = false): string {
  return [
    'const fs = require("node:fs");',
    'const { isBuiltin, registerHooks } = require("node:module");',
    'const { dirname, extname, join, normalize, relative, resolve } = require("node:path");',
    'const { fileURLToPath, pathToFileURL } = require("node:url");',
    "const commandDirectory = process.argv[1];",
    "const commandName = process.argv[2];",
    "const dependencyAncestorCount = Number.parseInt(process.argv[3], 10);",
    "const serverDependencyAncestorCount = Number.parseInt(process.argv[4], 10);",
    "const serverPackageFormat = process.argv[5];",
    "const dependencyAncestorFormats = JSON.parse(process.argv[6]);",
    "const providerRuntimeExecutableCount = Number.parseInt(process.argv[7], 10);",
    `const providerRuntimeEnvironmentVariable = process.env.${VERIFIED_PROVIDER_RUNTIME_TARGET_ENV};`,
    `delete process.env.${VERIFIED_PROVIDER_RUNTIME_TARGET_ENV};`,
    'if (process.platform !== "linux") throw new Error("ACPX provider relative module loading requires Linux descriptor-pinned paths");',
    `if (!Number.isSafeInteger(dependencyAncestorCount) || dependencyAncestorCount < 0 || dependencyAncestorCount > ${MAX_DEPENDENCY_ANCESTORS}) throw new Error("ACPX provider dependency ancestry is invalid");`,
    'if (!Number.isSafeInteger(serverDependencyAncestorCount) || serverDependencyAncestorCount < 0 || serverDependencyAncestorCount > dependencyAncestorCount) throw new Error("ACPX provider package ancestry is invalid");',
    'if ((serverPackageFormat !== "module" && serverPackageFormat !== "commonjs") || !Array.isArray(dependencyAncestorFormats) || dependencyAncestorFormats.length !== dependencyAncestorCount || dependencyAncestorFormats.some((value) => value !== "module" && value !== "commonjs")) throw new Error("ACPX provider package formats are invalid");',
    'if (providerRuntimeExecutableCount !== 0 && providerRuntimeExecutableCount !== 1) throw new Error("ACPX provider runtime executable count is invalid");',
    `const providerRuntimeExecutableFd = ${DEPENDENCY_ANCESTOR_FD_START} + dependencyAncestorCount;`,
    'if (providerRuntimeExecutableCount === 1) { if (providerRuntimeEnvironmentVariable !== "CODEX_PATH" && providerRuntimeEnvironmentVariable !== "CLAUDE_CODE_EXECUTABLE") throw new Error("ACPX provider runtime environment target is invalid"); fs.fstatSync(providerRuntimeExecutableFd); process.env[providerRuntimeEnvironmentVariable] = "/proc/" + process.pid + "/fd/" + providerRuntimeExecutableFd; } else if (providerRuntimeEnvironmentVariable !== undefined) throw new Error("ACPX provider runtime environment target is unexpected");',
    ...(guarded
      ? [
          `const guardianFd = ${DEPENDENCY_ANCESTOR_FD_START} + dependencyAncestorCount + providerRuntimeExecutableCount;`,
          'const guardian = fs.createReadStream("", { fd: guardianFd, autoClose: false });',
          `const reapCurrentProviderProcessGroup = ${reapCurrentProviderProcessGroup.toString()};`,
          "const killProviderProcess = process.kill.bind(process);",
          "const providerProcessId = process.pid;",
          "const exitProviderProcess = process.exit.bind(process);",
          "let guardianLost = false;",
          "const reapOnGuardianLoss = () => { if (guardianLost) return; guardianLost = true; reapCurrentProviderProcessGroup(killProviderProcess, providerProcessId, exitProviderProcess); };",
          'guardian.once("end", reapOnGuardianLoss);',
          'guardian.once("error", reapOnGuardianLoss);',
          "guardian.resume();",
          "fs.fstatSync(guardianFd + 1);",
          "fs.fstatSync(guardianFd + 2);",
          "fs.fstatSync(guardianFd + 3);",
        ]
      : []),
    "const commandPath = resolve(commandDirectory, commandName);",
    `const guardSnapshotModuleLookup = ${guardSnapshotModuleLookup.toString()};`,
    `const directory = process.platform === "linux" ? "/proc/self/fd/${COMMAND_DIRECTORY_FD}" : commandDirectory;`,
    "const directoryUrl = pathToFileURL(`${directory}/`).href;",
    "const pinnedTarget = new URL(commandName, directoryUrl).href;",
    'const target = process.platform === "linux" ? pinnedTarget : pathToFileURL(commandPath).href;',
    "process.argv.splice(1, 7, fileURLToPath(target));",
    `const dependencyDirectoryUrls = Array.from({ length: dependencyAncestorCount }, (_, index) => pathToFileURL("/proc/self/fd/" + (${DEPENDENCY_ANCESTOR_FD_START} + index) + "/").href);`,
    'const canonicalRootUrl = (url) => pathToFileURL(fs.realpathSync(fileURLToPath(url))).href.replace(/\\/?$/, "/");',
    'const canonicalDirectoryUrl = process.platform === "linux" ? canonicalRootUrl(directoryUrl) : directoryUrl;',
    'const canonicalDependencyDirectoryUrls = process.platform === "linux" ? dependencyDirectoryUrls.map(canonicalRootUrl) : dependencyDirectoryUrls;',
    "const dependencyAncestorByUrl = new Map([[target, 0]]);",
    `const descriptorFormatByUrl = new Map([[target, ${JSON.stringify(format)}]]);`,
    `const snapshotDescriptorAncestorIndex = ${snapshotDescriptorAncestorIndex.toString()};`,
    `const snapshotDescriptorResolution = ${snapshotDescriptorResolution.toString()};`,
    "const dependencyAncestorIndex = (url) => { const recorded = dependencyAncestorByUrl.get(url); return recorded === undefined ? snapshotDescriptorAncestorIndex(url, directoryUrl, dependencyDirectoryUrls) : recorded; };",
    `const guardSnapshotModuleResolution = ${guardSnapshotModuleResolution.toString()};`,
    'const canonicalizeDescriptorResolution = (url) => { if (typeof url !== "string" || !url.startsWith("file:") || snapshotDescriptorAncestorIndex(url, directoryUrl, dependencyDirectoryUrls) < 0) return url; try { return pathToFileURL(fs.realpathSync(fileURLToPath(url))).href; } catch { const error = new Error("ACPX provider module could not be canonicalized through its retained descriptor"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; } };',
    'const rememberDependencyAncestor = (specifier, resolution) => { const canonicalUrl = canonicalizeDescriptorResolution(resolution?.url); const pinned = snapshotDescriptorResolution(canonicalUrl, directoryUrl, dependencyDirectoryUrls, canonicalDirectoryUrl, canonicalDependencyDirectoryUrls); guardSnapshotModuleResolution(isBuiltin(specifier), resolution?.url, pinned !== null); if (pinned !== null && typeof resolution?.url === "string") { for (const rememberedUrl of [resolution.url, canonicalUrl, pinned.url]) { if (typeof rememberedUrl !== "string") continue; dependencyAncestorByUrl.set(rememberedUrl, pinned.ancestorIndex); if (typeof resolution.format === "string") descriptorFormatByUrl.set(rememberedUrl, resolution.format); } } return pinned === null || pinned.url === resolution?.url ? resolution : { ...resolution, url: pinned.url }; };',
    `const source = fs.readFileSync(${COMMAND_SOURCE_FD});`,
    "let resolvingDescriptorBare = false;",
    "const resolveBareFromDescriptor = (specifier, dependencyDirectoryUrl) => { resolvingDescriptorBare = true; try { return require.resolve(specifier, { paths: [fileURLToPath(dependencyDirectoryUrl)] }); } finally { resolvingDescriptorBare = false; } };",
    "registerHooks({ resolve(specifier, context, nextResolve) {",
    "if (resolvingDescriptorBare) return nextResolve(specifier, context);",
    "if (specifier === target) return { url: target, shortCircuit: true };",
    "const entryImport = context.parentURL === target;",
    "const parentDependencyAncestorIndex = entryImport ? 0 : dependencyAncestorIndex(context.parentURL);",
    'const relativeImport = (entryImport || parentDependencyAncestorIndex >= 0) && (specifier.startsWith("./") || specifier.startsWith("../"));',
    "const pinRelativeSpecifier = () => {",
    "const parentDescriptorIndex = context.parentURL.startsWith(directoryUrl) ? -1 : dependencyDirectoryUrls.findIndex((dependencyDirectoryUrl) => context.parentURL.startsWith(dependencyDirectoryUrl));",
    "if (parentDescriptorIndex < -1) return null;",
    "const parentRootUrl = parentDescriptorIndex === -1 ? directoryUrl : dependencyDirectoryUrls[parentDescriptorIndex];",
    "const parentDirectoryWithinRoot = relative(fileURLToPath(parentRootUrl), dirname(fileURLToPath(context.parentURL)));",
    "const relativePath = normalize(join(parentDirectoryWithinRoot, specifier));",
    'if (relativePath === "" || (!relativePath.startsWith("../") && relativePath !== "..")) return new URL(relativePath || ".", parentRootUrl);',
    "if (parentDescriptorIndex >= serverDependencyAncestorCount) return null;",
    'const segments = relativePath.split("/");',
    'let ancestorLevels = 0; while (segments[ancestorLevels] === "..") ancestorLevels += 1;',
    "const targetAncestorIndex = parentDescriptorIndex + ancestorLevels;",
    "if (ancestorLevels < 1 || targetAncestorIndex < 0 || targetAncestorIndex >= serverDependencyAncestorCount) return null;",
    'return new URL(segments.slice(ancestorLevels).join("/") || ".", dependencyDirectoryUrls[targetAncestorIndex]);',
    "};",
    "const pinnedSpecifier = relativeImport ? pinRelativeSpecifier() : null;",
    'if (relativeImport && pinnedSpecifier === null) { const error = new Error("ACPX provider relative module escaped its verified package"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; }',
    'const lookupSpecifier = pinnedSpecifier === null ? specifier : context.conditions?.includes("require") ? fileURLToPath(pinnedSpecifier) : pinnedSpecifier.href;',
    "const snapshotImport = entryImport || parentDependencyAncestorIndex >= 0;",
    'const bareImport = snapshotImport && !isBuiltin(specifier) && !specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/") && !specifier.includes(":");',
    "const filesystemLookup = snapshotImport && !isBuiltin(specifier);",
    "const lookupContext = entryImport && pinnedSpecifier === null && !isBuiltin(specifier) ? { ...context, parentURL: pinnedTarget } : context;",
    'const isMissingModuleError = (error) => error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND";',
    "return guardSnapshotModuleLookup(process.platform, filesystemLookup, () => {",
    "try { return rememberDependencyAncestor(specifier, nextResolve(lookupSpecifier, lookupContext)); } catch (error) {",
    "if (!bareImport || !isMissingModuleError(error)) throw error;",
    "let dependencyError = error;",
    "for (let dependencyIndex = Math.max(0, parentDependencyAncestorIndex); dependencyIndex < dependencyDirectoryUrls.length; dependencyIndex += 1) {",
    "const dependencyDirectoryUrl = dependencyDirectoryUrls[dependencyIndex];",
    'try { const candidateResolution = context.conditions?.includes("require") ? nextResolve(resolveBareFromDescriptor(specifier, dependencyDirectoryUrl), context) : nextResolve(specifier, { ...context, parentURL: new URL("package.json", dependencyDirectoryUrl).href }); return rememberDependencyAncestor(specifier, candidateResolution); } catch (candidateError) {',
    "if (!isMissingModuleError(candidateError)) throw candidateError;",
    "dependencyError = candidateError;",
    "}",
    "}",
    "throw dependencyError;",
    "}",
    "});",
    "}, load(url, context, nextLoad) {",
    `if (url === target) return { format: ${JSON.stringify(format)}, source, shortCircuit: true };`,
    "const dependencyDescriptorIndex = dependencyDirectoryUrls.findIndex((dependencyDirectoryUrl) => url.startsWith(dependencyDirectoryUrl));",
    "const descriptorLookup = url.startsWith(directoryUrl) || dependencyDescriptorIndex >= 0;",
    "guardSnapshotModuleResolution(false, url, descriptorLookup);",
    "return guardSnapshotModuleLookup(process.platform, descriptorLookup, () => {",
    "if (!descriptorLookup) return nextLoad(url, context);",
    "const canonicalRootUrl = url.startsWith(directoryUrl) ? canonicalDirectoryUrl : canonicalDependencyDirectoryUrls[dependencyDescriptorIndex];",
    "let moduleFd;",
    'try { moduleFd = fs.openSync(fileURLToPath(url), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { const error = new Error("ACPX provider module could not be opened without following its final component"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; }',
    "try {",
    "const metadataBefore = fs.fstatSync(moduleFd, { bigint: true });",
    `if (!metadataBefore.isFile() || metadataBefore.size > BigInt(${MAX_AGENT_COMMAND_BYTES})) { const error = new Error("ACPX provider module is not a bounded regular file"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; }`,
    'const openedUrl = pathToFileURL(fs.realpathSync("/proc/self/fd/" + moduleFd)).href;',
    'if (typeof canonicalRootUrl !== "string" || !openedUrl.startsWith(canonicalRootUrl)) { const error = new Error("ACPX provider module escaped descriptor-pinned ancestry"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; }',
    "const packageFormat = url.startsWith(directoryUrl) ? serverPackageFormat : dependencyAncestorFormats[dependencyDescriptorIndex];",
    "const hintedFormat = descriptorFormatByUrl.get(url) || context.format;",
    "const extension = extname(fileURLToPath(url));",
    'const moduleFormat = extension === ".mjs" ? "module" : extension === ".cjs" ? "commonjs" : extension === ".json" ? "json" : extension === ".node" ? "addon" : extension === ".js" ? (hintedFormat === "module" || hintedFormat === "commonjs" ? hintedFormat : packageFormat) : hintedFormat;',
    'if (moduleFormat !== "module" && moduleFormat !== "commonjs" && moduleFormat !== "json") { const error = new Error("ACPX provider module format is not supported by descriptor-pinned loading"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; }',
    "const admittedModuleBytes = Number(metadataBefore.size);",
    "const moduleBuffer = Buffer.alloc(admittedModuleBytes + 1);",
    "let moduleBytesRead = 0;",
    "while (moduleBytesRead < moduleBuffer.length) { const bytesRead = fs.readSync(moduleFd, moduleBuffer, moduleBytesRead, moduleBuffer.length - moduleBytesRead, moduleBytesRead); if (bytesRead === 0) break; moduleBytesRead += bytesRead; }",
    "const moduleSource = moduleBuffer.subarray(0, moduleBytesRead);",
    "const metadataAfter = fs.fstatSync(moduleFd, { bigint: true });",
    `if (moduleSource.length > ${MAX_AGENT_COMMAND_BYTES} || moduleSource.length !== admittedModuleBytes || BigInt(moduleSource.length) !== metadataAfter.size || metadataBefore.dev !== metadataAfter.dev || metadataBefore.ino !== metadataAfter.ino || metadataBefore.size !== metadataAfter.size || metadataBefore.mtimeNs !== metadataAfter.mtimeNs || metadataBefore.ctimeNs !== metadataAfter.ctimeNs) { const error = new Error("ACPX provider module changed while it was read"); error.code = "ERR_ACPX_UNVERIFIED_MODULE"; throw error; }`,
    "return { format: moduleFormat, source: moduleSource, shortCircuit: true };",
    "} finally { fs.closeSync(moduleFd); }",
    "});",
    "} });",
    "import(target).catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("");
}

export function guardSnapshotModuleLookup<T>(
  platform: NodeJS.Platform,
  filesystemLookup: boolean,
  lookup: () => T,
): T {
  if (platform !== "linux" && filesystemLookup) {
    throw new Error(
      "ACPX provider relative module loading requires Linux descriptor-pinned paths",
    );
  }
  return lookup();
}

/** Refuse filesystem modules that are not reached through a retained directory. */
export function guardSnapshotModuleResolution(
  builtin: boolean,
  resolvedUrl: unknown,
  descriptorAuthorized: boolean,
): void {
  if (
    !builtin &&
    typeof resolvedUrl === "string" &&
    resolvedUrl.startsWith("file:") &&
    !descriptorAuthorized
  ) {
    const error = new Error(
      "ACPX provider module escaped descriptor-pinned ancestry",
    );
    Object.assign(error, { code: "ERR_ACPX_UNVERIFIED_MODULE" });
    throw error;
  }
}

/** Locate a module URL within the command directory or retained ancestry. */
export function snapshotDescriptorAncestorIndex(
  resolvedUrl: unknown,
  commandDirectoryUrl: string,
  dependencyDirectoryUrls: readonly string[],
): number {
  if (typeof resolvedUrl !== "string") return -1;
  if (resolvedUrl.startsWith(commandDirectoryUrl)) return 0;
  return dependencyDirectoryUrls.findIndex((dependencyDirectoryUrl) =>
    resolvedUrl.startsWith(dependencyDirectoryUrl),
  );
}

/** Classify a canonical resolution and repin it to its retained descriptor. */
export function snapshotDescriptorResolution(
  resolvedUrl: unknown,
  commandDirectoryUrl: string,
  dependencyDirectoryUrls: readonly string[],
  canonicalCommandDirectoryUrl: string,
  canonicalDependencyDirectoryUrls: readonly string[],
): { url: string; ancestorIndex: number } | null {
  if (typeof resolvedUrl !== "string") return null;
  const descriptorIndex = snapshotDescriptorAncestorIndex(
    resolvedUrl,
    commandDirectoryUrl,
    dependencyDirectoryUrls,
  );
  if (descriptorIndex >= 0) {
    return { url: resolvedUrl, ancestorIndex: descriptorIndex };
  }
  if (
    canonicalDependencyDirectoryUrls.length !==
      dependencyDirectoryUrls.length ||
    !canonicalCommandDirectoryUrl.startsWith("file:") ||
    canonicalDependencyDirectoryUrls.some(
      (canonicalUrl) =>
        typeof canonicalUrl !== "string" || !canonicalUrl.startsWith("file:"),
    ) ||
    resolvedUrl.startsWith(new URL("../", commandDirectoryUrl).href)
  ) {
    return null;
  }
  if (resolvedUrl.startsWith(canonicalCommandDirectoryUrl)) {
    return {
      url:
        commandDirectoryUrl +
        resolvedUrl.slice(canonicalCommandDirectoryUrl.length),
      ancestorIndex: 0,
    };
  }
  const ancestorIndex = canonicalDependencyDirectoryUrls.findIndex(
    (canonicalUrl) => resolvedUrl.startsWith(canonicalUrl),
  );
  if (ancestorIndex < 0) return null;
  return {
    url:
      dependencyDirectoryUrls[ancestorIndex]! +
      resolvedUrl.slice(
        canonicalDependencyDirectoryUrls[ancestorIndex]!.length,
      ),
    ancestorIndex,
  };
}

function executableFormat(
  relativeCommand: string,
  packageType: unknown,
  agent: string,
): AcpxCommandFormat {
  const extension = extname(relativeCommand);
  if (extension === ".mjs") return "module";
  if (extension === ".cjs") return "commonjs";
  if (extension === ".js") {
    if (packageType === undefined || packageType === "commonjs") {
      return "commonjs";
    }
    if (packageType === "module") return "module";
  }
  throw new Error(`ACPX ${agent} package exposes an unsupported executable`);
}

function packageModuleFormat(packageType: unknown): AcpxCommandFormat {
  return packageType === "module" ? "module" : "commonjs";
}

function fileIdentity(metadata: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): VerifiedAcpxCommandIdentity {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    modifiedNanoseconds: metadata.mtimeNs.toString(),
    changedNanoseconds: metadata.ctimeNs.toString(),
  };
}

function directoryIdentity(metadata: {
  dev: bigint;
  ino: bigint;
}): VerifiedAcpxDirectoryIdentity {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  };
}

function sameDirectoryIdentity(
  left: VerifiedAcpxDirectoryIdentity,
  right: VerifiedAcpxDirectoryIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameIdentity(
  left: VerifiedAcpxCommandIdentity,
  right: VerifiedAcpxCommandIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

function oneExecutable(value: unknown, agent: string): string {
  const candidates =
    typeof value === "string"
      ? [value]
      : typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.values(value).filter(
            (candidate): candidate is string => typeof candidate === "string",
          )
        : [];
  const unique = Array.from(new Set(candidates));
  if (
    unique.length !== 1 ||
    unique[0]!.length === 0 ||
    unique[0]!.includes("\0") ||
    isAbsolute(unique[0]!)
  ) {
    throw new Error(
      `ACPX ${agent} package must expose one relative executable`,
    );
  }
  return unique[0]!;
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
    !isAbsolute(relativePath)
  );
}

function isInsideOrEqual(parent: string, child: string): boolean {
  return resolve(parent) === resolve(child) || isInside(parent, child);
}
