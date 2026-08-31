import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

const MAX_CODEX_CREDENTIAL_BYTES = 256 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const MAX_DIRECTORY_SYNC_ATTEMPTS = 8;
const DIRECTORY_SYNC_OPERATION_TIMEOUT_MS = 1_000;
const MAX_AUTONOMOUS_CREDENTIAL_CLEANUP_ATTEMPTS = 8;
const CREDENTIAL_CLEANUP_INTENT = ".paperclip-auth-cleanup-required";
const CREDENTIAL_STAGING_FILE = ".paperclip-auth-staging-v1";
const CREDENTIAL_LEASE_HOST = "127.0.0.1";
const CREDENTIAL_LEASE_PORT_MIN = 49_152;
const CREDENTIAL_LEASE_PORT_COUNT = 16_384;
const CREDENTIAL_LEASE_CANDIDATES = 3;
const CREDENTIAL_LEASE_QUORUM = 2;
const DIRECTORY_SYNC_HELPER_KILL_ACK_TIMEOUT_MS = 1_000;
const MAX_DIRECTORY_SYNC_HELPERS = 4;
const MAX_PARENT_DIRECTORY_SYNC_OPERATIONS = 4;
const DIRECTORY_SYNC_HELPER_SOURCE = String.raw`
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const directory = process.argv[1];
if (typeof directory !== "string") throw new Error("directory is required");
const handle = await open(
  directory,
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
);
try {
  await handle.sync();
} finally {
  await handle.close();
}
`;

interface CredentialHomeLock {
  assertHeld(): void;
  inheritanceFds(): readonly [number, number];
  activateLifetimeOwner(pid: number): Promise<void>;
  release(): Promise<void>;
}

interface QuarantinedCredentialCleanup {
  path: string;
  home: string;
  intentPath: string;
  ownerGeneration: CredentialLeaseGeneration;
  lock: CredentialHomeLock;
  recovery: Promise<void> | null;
}

type CredentialLeaseGeneration = number;

interface DirectorySyncHelperRegistry {
  activeChildren: Set<ChildProcess>;
  childDirectories: Map<ChildProcess, string>;
  activeParentOperations: Set<symbol>;
  attempts: Map<string, Promise<void>>;
  failedHomes: Set<string>;
  isolatedHomes: Set<string>;
  pendingCleanups: Map<string, Promise<void>>;
  stuckChildren: Map<string, ChildProcess>;
}

const quarantinedCredentialCleanups = new Map<
  string,
  QuarantinedCredentialCleanup
>();
const processDirectorySyncHelperState = globalThis as typeof globalThis & {
  __paperclipDirectorySyncHelperRegistryV1?: DirectorySyncHelperRegistry;
};
const directorySyncHelperRegistry =
  processDirectorySyncHelperState.__paperclipDirectorySyncHelperRegistryV1 ?? {
    activeChildren: new Set<ChildProcess>(),
    childDirectories: new Map<ChildProcess, string>(),
    activeParentOperations: new Set<symbol>(),
    attempts: new Map<string, Promise<void>>(),
    failedHomes: new Set<string>(),
    isolatedHomes: new Set<string>(),
    pendingCleanups: new Map<string, Promise<void>>(),
    stuckChildren: new Map<string, ChildProcess>(),
  };
processDirectorySyncHelperState.__paperclipDirectorySyncHelperRegistryV1 =
  directorySyncHelperRegistry;
const pendingDirectorySyncCleanups =
  directorySyncHelperRegistry.pendingCleanups;
const isolatedDirectorySyncHomes = directorySyncHelperRegistry.isolatedHomes;
const isolatedDirectorySyncAttempts = directorySyncHelperRegistry.attempts;
const failedIsolatedDirectorySyncHomes =
  directorySyncHelperRegistry.failedHomes;
const stuckDirectorySyncHelpers = directorySyncHelperRegistry.stuckChildren;
const directorySyncHelperDirectories =
  directorySyncHelperRegistry.childDirectories;
const activeCredentialLeaseGenerations = new Map<
  string,
  CredentialLeaseGeneration
>();
let nextCredentialLeaseGeneration = 0;

export type ManagedCodexCredentialMode =
  "api_key" | "inline_json" | "managed_file";

export interface AcpxProviderLifetimeLease {
  /** Duplicate both quorum listeners into the provider lifetime sentinel. */
  readonly lifetimeFenceFds: readonly [number, number];
  /** Validate the guardian while the provider-lifetime quorum is still held. */
  activateLifetimeOwner(pid: number): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedCodexCredentialLease
  extends AcpxProviderLifetimeLease {
  readonly path: string;
  readonly mode: ManagedCodexCredentialMode;
}

/**
 * Acquire the same kernel-backed provider lifetime ownership used by Codex
 * when an ACPX agent has no staged credential home of its own.
 */
export async function acquireAcpxProviderLifetimeLease(input: {
  agentHomeDirectory: string;
}): Promise<AcpxProviderLifetimeLease> {
  const home = await resolvePrivateAgentHome(input.agentHomeDirectory);
  const lock = await acquireCredentialHomeLock(home);
  let closed = false;
  let closeAttempt: Promise<void> | null = null;
  let lifetimeOwnerAttempt: Promise<void> | null = null;
  return Object.freeze({
    lifetimeFenceFds: lock.inheritanceFds(),
    async activateLifetimeOwner(pid: number): Promise<void> {
      if (closed || closeAttempt !== null) {
        throw new Error("ACPX provider lifetime lease is closing");
      }
      if (lifetimeOwnerAttempt !== null) return await lifetimeOwnerAttempt;
      const attempt = lock.activateLifetimeOwner(pid);
      lifetimeOwnerAttempt = attempt;
      try {
        await attempt;
      } finally {
        if (lifetimeOwnerAttempt === attempt) lifetimeOwnerAttempt = null;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      if (closeAttempt !== null) return await closeAttempt;
      const attempt = (async () => {
        await lifetimeOwnerAttempt?.catch(() => undefined);
        await lock.release();
        closed = true;
      })();
      closeAttempt = attempt;
      try {
        await attempt;
      } finally {
        if (closeAttempt === attempt) closeAttempt = null;
      }
    },
  });
}

/** Stage one explicit Codex authentication source in its isolated runtime home. */
export async function stageManagedCodexCredential(input: {
  agentHomeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  sourcePath?: string;
}): Promise<ManagedCodexCredentialLease> {
  const home = await resolvePrivateAgentHome(input.agentHomeDirectory);
  // Join an older failed close before claiming the next generation. This
  // keeps quarantine recovery authoritative over the shared paths without
  // mistaking a waiting admission for an already-active successor.
  await recoverQuarantinedCredentialCleanup(join(home, "auth.json"), home);
  const ownerGeneration = claimCredentialLeaseGeneration(home);
  let lock: CredentialHomeLock | null = null;
  try {
    lock = await acquireCredentialHomeLock(home);
    return await stageClaimedManagedCodexCredential(
      input,
      home,
      ownerGeneration,
      lock,
    );
  } catch (error) {
    if (
      lock !== null &&
      quarantinedCredentialCleanups.get(home)?.lock !== lock
    ) {
      await lock.release().catch(() => undefined);
    }
    releaseCredentialLeaseGeneration(home, ownerGeneration);
    throw error;
  }
}

async function resolvePrivateAgentHome(directory: string): Promise<string> {
  const home = await realpath(directory);
  const homeMetadata = await lstat(home);
  if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) {
    throw new Error("ACPX agent home must be a real directory");
  }
  if (
    process.platform !== "win32" &&
    ((homeMetadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        homeMetadata.uid !== process.getuid()))
  ) {
    throw new Error("ACPX agent home permissions are unsafe");
  }
  return home;
}

async function stageClaimedManagedCodexCredential(
  input: {
    environment?: NodeJS.ProcessEnv;
    sourcePath?: string;
  },
  home: string,
  ownerGeneration: CredentialLeaseGeneration,
  lock: CredentialHomeLock,
): Promise<ManagedCodexCredentialLease> {
  const destination = join(home, "auth.json");
  const stagingPath = join(home, CREDENTIAL_STAGING_FILE);
  const intentPath = join(home, CREDENTIAL_CLEANUP_INTENT);
  lock.assertHeld();
  await recoverPersistedCredentialCleanup(
    destination,
    stagingPath,
    home,
    intentPath,
  );
  // The isolated home is itself the durable recovery anchor. Scrub both the
  // installed credential and the deterministic staging pathname before every
  // admission, even when a prior cleanup-intent entry was lost with a runner
  // crash. Only after their absence is durable may a new intent be created.
  await removeCredentialArtifacts([destination, stagingPath], home);
  const environment = input.environment ?? {};
  const hasApiKey = Boolean(
    environment.CODEX_API_KEY || environment.OPENAI_API_KEY,
  );
  const inlineJson = environment.PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET;
  const hasInlineJson = typeof inlineJson === "string" && inlineJson.length > 0;
  const hasManagedFile =
    typeof input.sourcePath === "string" && input.sourcePath.length > 0;
  const sourceCount = [hasApiKey, hasInlineJson, hasManagedFile].filter(
    Boolean,
  ).length;
  if (sourceCount === 0) {
    throw new Error(
      "provider_initialize_protocol_error: provider=acpx stage=credential.stage managed Codex credential missing",
    );
  }
  if (sourceCount !== 1) {
    throw new Error("Managed Codex credential source is ambiguous");
  }

  if (
    hasManagedFile &&
    (!isAbsolute(input.sourcePath!) ||
      resolve(input.sourcePath!) === destination)
  ) {
    throw new Error(
      "Managed Codex credential source must be an external absolute path",
    );
  }

  if (hasApiKey) {
    // Codex will read the API key from the launch environment. Persist cleanup
    // intent before admitting the provider and retain it for the lease
    // lifetime, so a replacement runner removes provider-generated auth after
    // a crash before it admits another provider.
    // Failure while publishing the intent cannot strand a staged credential:
    // the unconditional admission scrub above is already durable and this
    // mode has not allowed the provider to create auth.json yet.
    await createCredentialCleanupIntent(intentPath, home);
    return credentialLease(
      destination,
      home,
      intentPath,
      "api_key",
      ownerGeneration,
      lock,
    );
  }

  const credential = hasInlineJson
    ? boundedInlineCredential(inlineJson!)
    : await readManagedCredential(input.sourcePath!);
  try {
    validateCredentialDocument(credential);
    // As with API-key mode, an intent-publication failure occurs before any
    // credential mutation and therefore needs no process-only quarantine.
    await createCredentialCleanupIntent(intentPath, home);
    try {
      await writeCredential(destination, stagingPath, home, credential);
    } catch (error) {
      // Rename may already have installed the credential before directory
      // durability failed. Retain a bounded process owner and the persisted
      // intent so later staging must recover both before admission.
      quarantineCredentialCleanup(
        destination,
        home,
        intentPath,
        ownerGeneration,
        lock,
      );
      throw error;
    }
  } finally {
    credential.fill(0);
  }
  return credentialLease(
    destination,
    home,
    intentPath,
    hasInlineJson ? "inline_json" : "managed_file",
    ownerGeneration,
    lock,
  );
}

function claimCredentialLeaseGeneration(
  home: string,
): CredentialLeaseGeneration {
  if (activeCredentialLeaseGenerations.has(home)) {
    throw new Error(
      "Managed Codex credential home already has an active lease",
    );
  }
  if (nextCredentialLeaseGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Managed Codex credential lease generation exhausted");
  }
  nextCredentialLeaseGeneration += 1;
  activeCredentialLeaseGenerations.set(home, nextCredentialLeaseGeneration);
  return nextCredentialLeaseGeneration;
}

function releaseCredentialLeaseGeneration(
  home: string,
  ownerGeneration: CredentialLeaseGeneration,
): void {
  if (activeCredentialLeaseGenerations.get(home) === ownerGeneration) {
    activeCredentialLeaseGenerations.delete(home);
  }
}

async function acquireCredentialHomeLock(
  home: string,
): Promise<CredentialHomeLock> {
  // This is deliberately markerless: authority is the live kernel ownership
  // of any two candidates. Any two subsets of a three-port set intersect, so
  // contenders cannot both reach quorum; one unrelated occupied listener is
  // tolerated without probing or trusting the process behind it.
  const servers: Server[] = [];
  let invalid: Error | null = null;
  let released = false;
  try {
    for (const port of credentialLeasePorts(home)) {
      const server = createServer((socket) => socket.destroy());
      try {
        await listenForCredentialLease(server, port);
      } catch (error) {
        await closeCredentialLeaseServer(server);
        if (errorCode(error) === "EADDRINUSE") continue;
        throw new Error(
          "Managed Codex credential ownership could not be established",
          { cause: error },
        );
      }
      server.on("error", (error) => {
        invalid ??= error;
      });
      server.on("close", () => {
        if (!released) {
          invalid ??= new Error(
            "Managed Codex credential ownership listener closed unexpectedly",
          );
        }
      });
      servers.push(server);
      if (servers.length === CREDENTIAL_LEASE_QUORUM) break;
    }
    if (servers.length !== CREDENTIAL_LEASE_QUORUM) {
      throw new Error(
        "Managed Codex credential home already has an active lease",
      );
    }
  } catch (error) {
    released = true;
    await Promise.allSettled(servers.map(closeCredentialLeaseServer));
    throw error;
  }
  let inheritanceFds: readonly [number, number];
  try {
    const first = credentialLeaseServerFd(servers[0]!);
    const second = credentialLeaseServerFd(servers[1]!);
    if (first === second) {
      throw new Error(
        "Managed Codex credential ownership listeners are not distinct",
      );
    }
    inheritanceFds = Object.freeze([first, second]) as readonly [
      number,
      number,
    ];
  } catch (error) {
    released = true;
    await Promise.allSettled(servers.map(closeCredentialLeaseServer));
    throw error;
  }

  return Object.freeze({
    assertHeld(): void {
      if (
        released ||
        invalid !== null ||
        servers.filter((server) => server.listening).length <
          CREDENTIAL_LEASE_QUORUM
      ) {
        throw new Error("Managed Codex credential ownership was lost");
      }
    },
    inheritanceFds(): readonly [number, number] {
      this.assertHeld();
      return inheritanceFds;
    },
    async activateLifetimeOwner(pid: number): Promise<void> {
      this.assertHeld();
      if (!Number.isSafeInteger(pid) || pid < 1) {
        throw new Error("Managed Codex credential lifetime owner is invalid");
      }
    },
    async release(): Promise<void> {
      if (released) return;
      const outcomes = await Promise.allSettled(
        servers.map(closeCredentialLeaseServer),
      );
      const listenersStillHeld = servers.filter(
        (server) => server.listening,
      ).length;
      if (listenersStillHeld >= CREDENTIAL_LEASE_QUORUM) {
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        throw new Error(
          "Managed Codex credential ownership could not be released",
          { cause: failure?.reason },
        );
      }
      // Once fewer than two listeners remain, quorum authority is gone. Never
      // throw after that point: a stale quarantine must not touch a successor.
      released = true;
    },
  });
}

function credentialLeasePorts(home: string): readonly number[] {
  const userScope =
    typeof process.getuid === "function" ? String(process.getuid()) : "win32";
  const digest = createHash("sha256")
    .update("paperclip-managed-codex-lease-v2:")
    .update(userScope)
    .update("\0")
    .update(home)
    .digest();
  const start = digest.readUInt16BE(0) % CREDENTIAL_LEASE_PORT_COUNT;
  const step = (digest.readUInt16BE(2) | 1) % CREDENTIAL_LEASE_PORT_COUNT;
  return Array.from(
    { length: CREDENTIAL_LEASE_CANDIDATES },
    (_, index) =>
      CREDENTIAL_LEASE_PORT_MIN +
      ((start + index * step) % CREDENTIAL_LEASE_PORT_COUNT),
  );
}

function credentialLeaseServerFd(server: Server): number {
  const fd = (server as Server & { _handle?: { fd?: unknown } })._handle?.fd;
  if (!Number.isSafeInteger(fd) || (fd as number) < 0) {
    throw new Error(
      "Managed Codex credential ownership listener cannot be inherited",
    );
  }
  return fd as number;
}
async function listenForCredentialLease(
  server: Server,
  port: number,
): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      exclusive: true,
      host: CREDENTIAL_LEASE_HOST,
      port,
    });
  });
}

async function closeCredentialLeaseServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}
function quarantineCredentialCleanup(
  path: string,
  home: string,
  intentPath: string,
  ownerGeneration: CredentialLeaseGeneration,
  lock: CredentialHomeLock,
): void {
  const existing = quarantinedCredentialCleanups.get(home);
  if (existing !== undefined) return;
  const cleanup: QuarantinedCredentialCleanup = {
    path,
    home,
    intentPath,
    ownerGeneration,
    lock,
    recovery: null,
  };
  quarantinedCredentialCleanups.set(home, cleanup);
  startCredentialCleanupRecovery(
    cleanup,
    MAX_AUTONOMOUS_CREDENTIAL_CLEANUP_ATTEMPTS,
  );
}

function startCredentialCleanupRecovery(
  cleanup: QuarantinedCredentialCleanup,
  maxAttempts: number,
): Promise<void> {
  if (cleanup.recovery) return cleanup.recovery;
  const recovery = (async () => {
    let retryDelayMs = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // Never let a stale cleanup callback mutate a successor's credential
        // after kernel ownership has been lost.
        assertCredentialCleanupAuthority(cleanup);
        await removeReplaceableCredential(cleanup.path);
        await removeReplaceableCredential(
          join(cleanup.home, CREDENTIAL_STAGING_FILE),
        );
        assertCredentialCleanupAuthority(cleanup);
        await syncDirectory(cleanup.home);
        assertCredentialCleanupAuthority(cleanup);
        await removeCredentialCleanupIntent(cleanup.intentPath, cleanup.home);
        assertCredentialCleanupAuthority(cleanup);
        await cleanup.lock.release();
        quarantinedCredentialCleanups.delete(cleanup.home);
        return;
      } catch {
        if (attempt === maxAttempts) return;
        await new Promise<void>((resolveRetry) => {
          const timer = setTimeout(resolveRetry, retryDelayMs);
          timer.unref?.();
        });
        retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
      }
    }
  })();
  cleanup.recovery = recovery;
  void recovery
    .finally(() => {
      if (cleanup.recovery === recovery) cleanup.recovery = null;
    })
    .catch(() => undefined);
  return recovery;
}

function assertCredentialCleanupAuthority(
  cleanup: QuarantinedCredentialCleanup,
): void {
  const activeGeneration = activeCredentialLeaseGenerations.get(cleanup.home);
  if (
    activeGeneration !== undefined &&
    activeGeneration !== cleanup.ownerGeneration
  ) {
    throw new Error(
      "Managed Codex credential cleanup was superseded by an active lease",
    );
  }
  cleanup.lock.assertHeld();
}

async function recoverQuarantinedCredentialCleanup(
  path: string,
  home: string,
): Promise<void> {
  const cleanup = quarantinedCredentialCleanups.get(home);
  if (cleanup === undefined) return;
  await (cleanup.recovery ?? startCredentialCleanupRecovery(cleanup, 1));
  if (!quarantinedCredentialCleanups.has(home)) return;
  const admissionRecovery = startCredentialCleanupRecovery(cleanup, 1);
  await admissionRecovery;
  if (quarantinedCredentialCleanups.has(home)) {
    throw new Error(
      `Managed Codex credential cleanup remains non-durable for ${path}`,
    );
  }
}

async function recoverPersistedCredentialCleanup(
  path: string,
  stagingPath: string,
  home: string,
  intentPath: string,
): Promise<void> {
  if (!(await pathExists(intentPath))) return;
  await removeCredentialArtifacts([path, stagingPath], home);
  await removeCredentialCleanupIntent(intentPath, home);
}

function credentialLease(
  path: string,
  home: string,
  intentPath: string,
  mode: ManagedCodexCredentialMode,
  ownerGeneration: CredentialLeaseGeneration,
  lock: CredentialHomeLock,
): ManagedCodexCredentialLease {
  // Do not admit a provider if kernel ownership was lost while its credential
  // was being staged.
  lock.assertHeld();
  let closed = false;
  let closeAttempt: Promise<void> | null = null;
  let lifetimeOwnerAttempt: Promise<void> | null = null;
  return Object.freeze({
    path,
    mode,
    lifetimeFenceFds: lock.inheritanceFds(),
    async activateLifetimeOwner(pid: number): Promise<void> {
      if (closed || closeAttempt !== null) {
        throw new Error("Managed Codex credential lease is closing");
      }
      if (lifetimeOwnerAttempt !== null) return await lifetimeOwnerAttempt;
      const attempt = lock.activateLifetimeOwner(pid);
      lifetimeOwnerAttempt = attempt;
      try {
        await attempt;
      } finally {
        if (lifetimeOwnerAttempt === attempt) lifetimeOwnerAttempt = null;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      if (closeAttempt !== null) return await closeAttempt;
      const attempt = (async () => {
        await lifetimeOwnerAttempt?.catch(() => undefined);
        const activeGeneration = activeCredentialLeaseGenerations.get(home);
        if (activeGeneration !== ownerGeneration) {
          // A failed close releases its generation only after publishing a
          // quarantine owner. If no successor exists, synchronously join that
          // cleanup before acknowledging the retry. If a successor does
          // exist, this stale lease has no authority over its credential.
          if (activeGeneration === undefined) {
            await recoverQuarantinedCredentialCleanup(path, home);
            await lock.release();
          }
          closed = true;
          return;
        }
        try {
          lock.assertHeld();
          await removeCredential(path, home);
          await removeCredentialCleanupIntent(intentPath, home);
          await lock.release();
          closed = true;
        } catch (error) {
          quarantineCredentialCleanup(
            path,
            home,
            intentPath,
            ownerGeneration,
            lock,
          );
          throw error;
        } finally {
          releaseCredentialLeaseGeneration(home, ownerGeneration);
        }
      })();
      closeAttempt = attempt;
      try {
        await attempt;
      } finally {
        if (closeAttempt === attempt) closeAttempt = null;
      }
    },
  });
}

async function createCredentialCleanupIntent(
  intentPath: string,
  home: string,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      intentPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile("paperclip-managed-codex-cleanup-v1\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectoryDurably(home);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeCredentialCleanupIntent(
  intentPath: string,
  home: string,
): Promise<void> {
  await removeReplaceableCredential(intentPath);
  await syncDirectoryDurably(home);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function boundedInlineCredential(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_CODEX_CREDENTIAL_BYTES) {
    bytes.fill(0);
    throw new Error(
      "Managed Codex credential document exceeds its bounded size",
    );
  }
  return bytes;
}

async function readManagedCredential(sourcePath: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(
      "provider_initialize_protocol_error: provider=acpx stage=credential.stage managed Codex credential missing",
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_CODEX_CREDENTIAL_BYTES)
    ) {
      throw new Error(
        "Managed Codex credential source is not a bounded regular file",
      );
    }
    if (process.platform !== "win32" && (before.mode & 0o077n) !== 0n) {
      throw new Error("Managed Codex credential source permissions are unsafe");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      before.uid !== BigInt(process.getuid())
    ) {
      throw new Error("Managed Codex credential source ownership is unsafe");
    }
    const bytes = await readHandle(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(bytes.length)
    ) {
      bytes.fill(0);
      throw new Error("Managed Codex credential source changed while read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readHandle(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) {
    bytes.fill(0);
    throw new Error("Managed Codex credential source ended while read");
  }
  return bytes;
}

function validateCredentialDocument(bytes: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Managed Codex credential source is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed Codex credential source is malformed");
  }
}

async function writeCredential(
  destination: string,
  temporaryPath: string,
  home: string,
  bytes: Buffer,
): Promise<void> {
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
    throw new Error("Managed Codex credential destination could not be opened");
  }
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"].includes(
          errorCode(error) ?? "",
        )
      ) {
        throw error;
      }
      // Win32 rename does not replace an existing destination. Remove only
      // the already-conflicting pathname (never a real directory), then move
      // the fully synced private temporary file into place.
      await removeReplaceableCredential(destination);
      await rename(temporaryPath, destination);
    }
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
  // Do not acknowledge the lease until the namespace update is durable. A
  // directory-sync failure is a fail-closed admission condition: retry here so
  // neither a returned lease nor a thrown pre-lease error can lose ownership
  // of auth.json across a crash.
  await syncDirectoryDurably(home);
}

async function removeReplaceableCredential(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error("Managed Codex credential destination is a directory");
    }
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function removeCredential(path: string, home: string): Promise<void> {
  await removeCredentialArtifacts([path], home);
}

async function removeCredentialArtifacts(
  paths: readonly string[],
  home: string,
): Promise<void> {
  for (const path of paths) {
    await removeReplaceableCredential(path);
  }
  // Sync even after ENOENT: a previous unlink may have succeeded before its
  // directory sync failed. Never report cleanup or finish preflight while the
  // removal can still be rolled back by a crash.
  await syncDirectoryDurably(home);
}

async function syncDirectoryDurably(directory: string): Promise<void> {
  let retryDelayMs = 10;
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_DIRECTORY_SYNC_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      await syncDirectory(directory);
      return;
    } catch (error) {
      lastError = error;
      if (
        attempt === MAX_DIRECTORY_SYNC_ATTEMPTS ||
        error instanceof DirectorySyncOperationTimeoutError ||
        error instanceof UnconfirmedDirectorySyncHelperTerminationError
      ) {
        break;
      }
      // Keep admission closed during transient failures, while bounding total
      // startup/shutdown latency for a persistently unhealthy filesystem.
      await new Promise<void>((resolveRetry) => {
        setTimeout(resolveRetry, retryDelayMs);
      });
      retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
    }
  }
  const attemptNoun = attempts === 1 ? "attempt" : "attempts";
  throw new Error(
    `Managed Codex credential directory remained non-durable after ${attempts} ${attemptNoun}`,
    { cause: lastError },
  );
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  reclaimConfirmedExitedDirectorySyncHelpers();
  // Once an in-process filesystem request times out it cannot be cancelled.
  // Keep that single request observed, and permanently use killable helper
  // processes for this home so recovery remains available without accumulating
  // additional parent-process handles or requests.
  if (isolatedDirectorySyncHomes.has(directory)) {
    if (failedIsolatedDirectorySyncHomes.has(directory)) {
      throw new UnconfirmedDirectorySyncHelperTerminationError(directory);
    }
    await syncDirectoryInIsolatedProcess(directory);
    return;
  }
  const parentOperation = reserveParentDirectorySyncOperation();
  if (parentOperation === null) {
    // Never start a fifth uncancellable parent filesystem request. The helper
    // pool has its own global bound and can be killed independently.
    isolatedDirectorySyncHomes.add(directory);
    await syncDirectoryInIsolatedProcess(directory);
    return;
  }
  let retainParentOperation = false;
  try {
    const openAttempt = open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    let handle: FileHandle;
    try {
      handle = await waitForDirectorySyncOperation(
        openAttempt,
        "open",
        directory,
      );
    } catch (error) {
      if (error instanceof DirectorySyncOperationTimeoutError) {
        // open(2) cannot be cancelled. Retain this process-global reservation
        // for the process lifetime and observe/close a late handle without
        // ever starting another parent request for this home.
        retainParentOperation = true;
        const cleanupAttempt = openAttempt.then(
          (lateHandle) => closeDirectoryHandle(lateHandle, directory),
          () => undefined,
        );
        retainDirectorySyncCleanup(directory, cleanupAttempt);
        isolatedDirectorySyncHomes.add(directory);
        await syncDirectoryInIsolatedProcess(directory);
        return;
      }
      throw error;
    }

    let syncAttempt: Promise<void>;
    try {
      syncAttempt = handle.sync();
    } catch (error) {
      retainParentOperation = await closeDirectoryHandle(handle, directory);
      throw error;
    }
    let syncTimedOut = false;
    try {
      await waitForDirectorySyncOperation(syncAttempt, "fsync", directory);
    } catch (error) {
      syncTimedOut = error instanceof DirectorySyncOperationTimeoutError;
      if (syncTimedOut) {
        // FileHandle.close() waits for outstanding operations. Retain both the
        // cleanup observer and the parent-operation slot for process lifetime.
        retainParentOperation = true;
        const cleanupAttempt = syncAttempt.then(
          () => handle.close().catch(() => undefined),
          () => handle.close().catch(() => undefined),
        );
        retainDirectorySyncCleanup(directory, cleanupAttempt);
        isolatedDirectorySyncHomes.add(directory);
        await syncDirectoryInIsolatedProcess(directory);
        return;
      }
      throw error;
    } finally {
      // A completed fsync is the durability boundary. Close is resource
      // cleanup; a timed-out close retains the global parent-operation slot.
      if (!syncTimedOut) {
        retainParentOperation =
          (await closeDirectoryHandle(handle, directory)) ||
          retainParentOperation;
      }
    }
  } finally {
    if (!retainParentOperation) {
      directorySyncHelperRegistry.activeParentOperations.delete(
        parentOperation,
      );
    }
  }
}

async function closeDirectoryHandle(
  handle: FileHandle,
  directory: string,
): Promise<boolean> {
  try {
    const closeAttempt = handle.close();
    try {
      await waitForDirectorySyncOperation(closeAttempt, "close", directory);
    } catch (error) {
      // close(2) cannot be cancelled. Keep observing a late rejection without
      // leaking additional directory handles. Admission remains closed until
      // the real close settles, while a completed fsync stays successful.
      if (error instanceof DirectorySyncOperationTimeoutError) {
        retainDirectorySyncCleanup(directory, closeAttempt);
        isolatedDirectorySyncHomes.add(directory);
        return true;
      } else {
        void closeAttempt.catch(() => undefined);
      }
    }
  } catch {
    // Closing cannot invalidate an fsync that already completed, and callers
    // with a failed fsync must retain that original durability error.
  }
  return false;
}

function reserveParentDirectorySyncOperation(): symbol | null {
  if (
    directorySyncHelperRegistry.activeParentOperations.size >=
    MAX_PARENT_DIRECTORY_SYNC_OPERATIONS
  ) {
    return null;
  }
  const reservation = Symbol("parent-directory-sync");
  directorySyncHelperRegistry.activeParentOperations.add(reservation);
  return reservation;
}

async function syncDirectoryInIsolatedProcess(
  directory: string,
): Promise<void> {
  reclaimConfirmedExitedDirectorySyncHelpers();
  if (failedIsolatedDirectorySyncHomes.has(directory)) {
    throw new UnconfirmedDirectorySyncHelperTerminationError(directory);
  }
  const activeAttempt = isolatedDirectorySyncAttempts.get(directory);
  if (activeAttempt !== undefined) return await activeAttempt;
  const attempt = runDirectorySyncHelper(directory);
  isolatedDirectorySyncAttempts.set(directory, attempt);
  try {
    await attempt;
  } finally {
    if (isolatedDirectorySyncAttempts.get(directory) === attempt) {
      isolatedDirectorySyncAttempts.delete(directory);
    }
  }
}

async function runDirectorySyncHelper(directory: string): Promise<void> {
  reclaimConfirmedExitedDirectorySyncHelpers();
  if (
    directorySyncHelperRegistry.activeChildren.size >=
    MAX_DIRECTORY_SYNC_HELPERS
  ) {
    throw new Error(
      `Managed Codex credential directory helper process limit of ${MAX_DIRECTORY_SYNC_HELPERS} was reached`,
    );
  }
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        DIRECTORY_SYNC_HELPER_SOURCE,
        directory,
      ],
      {
        // The helper imports only Node built-ins. Do not inherit loader hooks or
        // any credential-bearing process environment into the durability worker.
        env: {},
        stdio: "ignore",
        windowsHide: true,
      },
    );
    directorySyncHelperRegistry.activeChildren.add(child);
    directorySyncHelperDirectories.set(child, directory);
    child.unref();
  } catch (error) {
    throw new Error(
      `Managed Codex credential directory helper could not start for ${directory}`,
      { cause: error },
    );
  }
  await new Promise<void>((resolveHelper, rejectHelper) => {
    let timeout: NodeJS.Timeout | undefined;
    let killAcknowledgementTimeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;
    let reaped = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killAcknowledgementTimeout !== undefined) {
        clearTimeout(killAcknowledgementTimeout);
      }
      if (error === undefined) resolveHelper();
      else rejectHelper(error);
    };
    const reap = (): void => {
      if (reaped) return;
      reaped = true;
      directorySyncHelperRegistry.activeChildren.delete(child);
      directorySyncHelperDirectories.delete(child);
      if (stuckDirectorySyncHelpers.get(directory) === child) {
        stuckDirectorySyncHelpers.delete(directory);
        failedIsolatedDirectorySyncHomes.delete(directory);
      }
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    const fenceUntilExitConfirmed = (): void => {
      failedIsolatedDirectorySyncHomes.add(directory);
      stuckDirectorySyncHelpers.set(directory, child);
      settle(new UnconfirmedDirectorySyncHelperTerminationError(directory));
    };
    const onError = (): void => {
      fenceUntilExitConfirmed();
      // A missing pid proves spawn never created a process, so no retained
      // reaper or global capacity slot is necessary.
      if (child.pid === undefined) reap();
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      reap();
      if (timedOut) {
        settle(new DirectorySyncOperationTimeoutError("helper", directory));
      } else if (code === 0) {
        settle();
      } else {
        settle(
          new Error(
            `Managed Codex credential directory helper failed with ${
              signal === null ? `code ${String(code)}` : `signal ${signal}`
            }`,
          ),
        );
      }
    };
    const onClose = (): void => reap();
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    timeout = setTimeout(() => {
      timedOut = true;
      // Wait for the exit event after SIGKILL before permitting another helper;
      // this is the resource-release acknowledgement the in-process API lacks.
      try {
        if (!child.kill("SIGKILL")) {
          fenceUntilExitConfirmed();
          reclaimConfirmedExitedDirectorySyncHelpers();
          return;
        }
        killAcknowledgementTimeout = setTimeout(() => {
          // A child that does not acknowledge SIGKILL is retained as the sole
          // reaper for this home. Fail closed until an event or a kernel probe
          // confirms exit, so no later attempt can accumulate another process.
          fenceUntilExitConfirmed();
          reclaimConfirmedExitedDirectorySyncHelpers();
        }, DIRECTORY_SYNC_HELPER_KILL_ACK_TIMEOUT_MS);
        killAcknowledgementTimeout.unref?.();
      } catch {
        fenceUntilExitConfirmed();
        reclaimConfirmedExitedDirectorySyncHelpers();
      }
    }, DIRECTORY_SYNC_OPERATION_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function reclaimConfirmedExitedDirectorySyncHelpers(): void {
  for (const child of directorySyncHelperRegistry.activeChildren) {
    let exited =
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined);
    if (!exited && child.pid !== undefined) {
      try {
        // ChildProcess events are advisory for capacity accounting: an exited
        // helper can fail to deliver `exit`/`close` while its owner is under
        // pressure. A signal-0 ESRCH result is the kernel confirmation that
        // reclaiming this global slot cannot permit another live helper.
        process.kill(child.pid, 0);
      } catch (error) {
        exited = errorCode(error) === "ESRCH";
      }
    }
    if (!exited) continue;
    directorySyncHelperRegistry.activeChildren.delete(child);
    const directory =
      directorySyncHelperDirectories.get(child) ??
      [...stuckDirectorySyncHelpers].find(([, owner]) => owner === child)?.[0];
    directorySyncHelperDirectories.delete(child);
    if (directory && stuckDirectorySyncHelpers.get(directory) === child) {
      stuckDirectorySyncHelpers.delete(directory);
      failedIsolatedDirectorySyncHomes.delete(directory);
    }
  }
}

function retainDirectorySyncCleanup(
  directory: string,
  attempt: Promise<unknown>,
): void {
  const observed = attempt.then(
    () => undefined,
    () => undefined,
  );
  const prior = pendingDirectorySyncCleanups.get(directory);
  const barrier =
    prior === undefined
      ? observed
      : Promise.allSettled([prior, observed]).then(() => undefined);
  pendingDirectorySyncCleanups.set(directory, barrier);
  void barrier
    .finally(() => {
      if (pendingDirectorySyncCleanups.get(directory) === barrier) {
        pendingDirectorySyncCleanups.delete(directory);
      }
    })
    .catch(() => undefined);
}

class DirectorySyncOperationTimeoutError extends Error {
  constructor(
    operation: "open" | "fsync" | "close" | "helper",
    directory: string,
  ) {
    super(
      `Managed Codex credential directory ${operation} timed out after ${DIRECTORY_SYNC_OPERATION_TIMEOUT_MS}ms for ${directory}`,
    );
    this.name = "DirectorySyncOperationTimeoutError";
  }
}

class UnconfirmedDirectorySyncHelperTerminationError extends Error {
  constructor(directory: string) {
    super(
      `Managed Codex credential directory helper termination was not acknowledged for ${directory}`,
    );
    this.name = "UnconfirmedDirectorySyncHelperTerminationError";
  }
}

async function waitForDirectorySyncOperation<T>(
  operationAttempt: Promise<T>,
  operation: "open" | "fsync" | "close",
  directory: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operationAttempt,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new DirectorySyncOperationTimeoutError(operation, directory));
        }, DIRECTORY_SYNC_OPERATION_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}
