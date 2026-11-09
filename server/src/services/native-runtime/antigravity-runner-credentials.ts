import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeAntigravityCredential, verifyAntigravityCredential } from "../../vendor/paperclip-runner/index.js";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { reconcileRetainedGoogleCleanupForHome, retainGoogleCredentialCleanupForHome, retainGoogleCredentialCleanup, type RetainedGoogleCleanupScope } from "../retained-google-credential-cleanup.js";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { openRunnerWorkspaceFile } from "./runner-api-files.js";
import type { NativeSession, createRunnerdCodexTransport } from "../../vendor/paperclip-runner/index.js";
import { bindManagedNativeCredentialTurn } from "./managed-native-credentials.js";

const AUTH_SECRET = "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET";
const TOKEN_FILE = "acp_token.json";
const REFRESH_FILE = "auth-refresh.json";
const retirementProofs = new WeakMap<object, () => Promise<void>>();
type RunnerdTransport = ReturnType<typeof createRunnerdCodexTransport>;

/** Preserve the exact process owner's proof without changing a failed native
 * session's durable settlement error or making that session reusable. */
export function bindAntigravityTransportRetirement(bundle: RunnerdTransport): RunnerdTransport["transport"] {
  const close = bundle.transport.close.bind(bundle.transport);
  bundle.transport.close = async reason => {
    try { await close(reason); }
    catch (error) {
      if (error && typeof error === "object" && bundle.retireProbeResources) {
        retirementProofs.set(error, () => bundle.retireProbeResources!());
      }
      throw error;
    }
  };
  return bundle.transport;
}

/** Only explicit run credentials may enter Antigravity's isolated runtime. */
export async function prepareAntigravityRunnerCredentials(input: {
  environment: NodeJS.ProcessEnv;
  remote: boolean;
  managedHome?: string;
  lifecycleMode?: "per_turn" | "warm";
}): Promise<{ environment: NodeJS.ProcessEnv; home: string | null; credential?: string }> {
  const environment = { ...input.environment };
  for (const key of [AUTH_SECRET, "GEMINI_HOME", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_ACCESS_TOKEN"]) delete environment[key];
  if (environment.GEMINI_API_KEY?.trim()) return { environment, home: null };
  delete environment.GEMINI_API_KEY;
  if (input.remote) throw new Error("Google Antigravity subscription authentication is not qualified for remote environments. Select a Google API key or use the Paperclip host.");
  if (input.lifecycleMode === "warm") throw new Error("Google Antigravity subscription authentication requires turn-by-turn sessions; warm sessions are not qualified.");
  const home = input.managedHome?.trim();
  if (!home) throw new Error("Google Antigravity requires a selected managed Google account or Google API key.");
  await reconcileRetainedGoogleCleanupForHome(home);
  let credential: string;
  try {
    credential = sanitizeAntigravityCredential(await readLocalAiCredentialFile(join(home, "antigravity-acp", TOKEN_FILE)));
  } catch {
    throw new Error("The selected Google Antigravity account is unavailable. Reconnect the Google account, then retry.");
  }
  environment[AUTH_SECRET] = credential;
  return { environment, home, credential };
}

/** A changed refresh token must prove the same saved Google identity before
 * the connection owner may apply its generation-checked encrypted writeback. */
export async function prepareAntigravityCredentialWriteback(input: {
  originalCredential: string;
  refreshedCredential: string;
  managedHome: string;
  accountEmail?: string;
}): Promise<string> {
  const original = JSON.parse(sanitizeAntigravityCredential(input.originalCredential));
  const refreshed = sanitizeAntigravityCredential(input.refreshedCredential);
  const candidate = JSON.parse(refreshed);
  if (candidate.refresh_token === original.refresh_token && candidate.client_secret === original.client_secret) return refreshed;
  if (!input.accountEmail) throw new Error("The Google account identity is unavailable for credential refresh. Reconnect the account.");
  const verified = await verifyAntigravityCredential(input.managedHome);
  if (verified.accountEmail.toLowerCase() !== input.accountEmail.toLowerCase()) {
    throw new Error("The refreshed Google account does not match the selected connection.");
  }
  return verified.credential;
}

/** Recover only an encrypted refresh from an owner that already retired. A
 * disposable verification home cannot inherit any provider process lifetime. */
export async function prepareAntigravityCredentialRecovery(input: {
  originalCredential: string; refreshedCredential: string; accountEmail: string;
  scope: RetainedGoogleCleanupScope;
  persistVerified: (credential: string) => Promise<void>;
}): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-google-recovery-")));
  const directory = join(home, "antigravity-acp");
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, TOKEN_FILE), sanitizeAntigravityCredential(input.refreshedCredential), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  let verified: string | undefined;
  let persisted = false;
  const cleanup = () => withAccountHomeSecretMutationLock(undefined, input.scope.companyId, async () => {
    // A failed verification may itself have rotated the token. Retry the
    // private home's current generation, never the earlier journal value.
    if (!persisted) {
      const refreshedCredential = await readLocalAiCredentialFile(join(directory, TOKEN_FILE));
      verified = await prepareAntigravityCredentialWriteback({ ...input, refreshedCredential, managedHome: home });
      await input.persistVerified(verified);
      persisted = true;
    }
    await rm(home, { recursive: true, force: true });
  });
  try {
    await cleanup();
    return verified!;
  } catch (error) {
    retainGoogleCredentialCleanup({ scope: input.scope, cleanup, home });
    throw error;
  }
}

/** Lifecycle callbacks copy into this invocation's home, never a shared login. */
export function antigravityCredentialTurn(input: {
  managedHome: string;
  runtimeHome: string;
  credential: string;
}) {
  const runtimeDirectory = join(input.runtimeHome, "antigravity-acp");
  const destination = join(input.managedHome, "antigravity-acp", TOKEN_FILE);
  let pendingStage: { path: string; directoryDev: number; directoryIno: number; dev?: number; ino?: number } | undefined;
  return {
    copyBack: async () => {
      let serialized: string;
      try {
        try { serialized = await readLocalAiCredentialFile(join(runtimeDirectory, TOKEN_FILE)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          serialized = await readLocalAiCredentialFile(join(runtimeDirectory, REFRESH_FILE));
        }
      } catch (error) {
        // A provider that never started has no refresh to preserve.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !pendingStage) return;
        throw new Error("Google Antigravity credential refresh handoff is invalid.");
      }
      const refreshed = sanitizeAntigravityCredential(serialized);
      if (refreshed === input.credential) {
        if (pendingStage) throw new Error("Google Antigravity credential refresh handoff is invalid.");
        return;
      }
      const destinationDirectory = join(input.managedHome, "antigravity-acp");
      await withDirectoryMergeLock(destinationDirectory, async () => {
        const directory = await openRunnerWorkspaceFile(destinationDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
        let staged: Awaited<ReturnType<typeof openRunnerWorkspaceFile>> | undefined;
        let stagedOwned = false;
        const stagedPath = join(destinationDirectory, `.acp_token.copyback-${randomUUID()}.tmp`);
        let cleanupStage: (() => Promise<void>) | undefined;
        try {
          const owner = await directory.stat();
          if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) {
            throw new Error("Google Antigravity credential destination is invalid.");
          }
          const assertDirectoryOwner = async () => {
            const current = await openRunnerWorkspaceFile(destinationDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
            try {
              const metadata = await current.stat();
              if (metadata.dev !== owner.dev || metadata.ino !== owner.ino || metadata.uid !== owner.uid || (metadata.mode & 0o077) !== 0) {
                throw new Error("Google Antigravity credential destination changed during execution.");
              }
            } finally { await current.close(); }
          };
          cleanupStage = async () => {
            if (!pendingStage) return;
            if (pendingStage.directoryDev !== owner.dev || pendingStage.directoryIno !== owner.ino) {
              throw new Error("Google Antigravity credential staging ownership changed.");
            }
            if (pendingStage.dev === undefined || pendingStage.ino === undefined) {
              if (!staged) throw new Error("Google Antigravity credential staging ownership is unavailable.");
              const created = await staged.stat();
              pendingStage.dev = created.dev; pendingStage.ino = created.ino;
            }
            const previous = await openRunnerWorkspaceFile(pendingStage.path, constants.O_RDONLY)
              .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
            if (previous) {
              try {
                const metadata = await previous.stat();
                if (!metadata.isFile() || metadata.dev !== pendingStage.dev || metadata.ino !== pendingStage.ino
                  || metadata.nlink !== 1 || metadata.uid !== owner.uid || (metadata.mode & 0o777) !== 0o600) {
                  throw new Error("Google Antigravity credential staging ownership changed.");
                }
              } finally { await previous.close(); }
            }
            await rm(pendingStage.path, { force: true });
            pendingStage = undefined;
          };
          // A failed removal remains this owner's obligation on the next retry.
          await cleanupStage();
          const readDestination = async (sync = false) => {
            const file = await openRunnerWorkspaceFile(destination, constants.O_RDONLY);
            const bytes = Buffer.alloc(65_537);
            try {
              const metadata = await file.stat();
              if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 65_536) {
                throw new Error("Google Antigravity credential destination is invalid.");
              }
              let size = 0;
              while (size < bytes.length) {
                const result = await file.read(bytes, size, bytes.length - size, size);
                if (!result.bytesRead) break;
                size += result.bytesRead;
              }
              if (size > 65_536) throw new Error("Google Antigravity credential destination changed during execution.");
              const current = sanitizeAntigravityCredential(bytes.subarray(0, size).toString("utf8"));
              if (current !== input.credential && current !== refreshed) {
                throw new Error("Google Antigravity credential destination changed during execution.");
              }
              if (sync) await file.sync();
              return { metadata, current };
            } finally { bytes.fill(0); await file.close(); }
          };
          const original = await readDestination();
          if (original.current === refreshed) {
            // A previous rename may have committed before its directory fsync
            // or close failed. Confirm exactly that generation before cleanup.
            const synced = await readDestination(true);
            await directory.sync();
            await assertDirectoryOwner();
            const confirmed = await readDestination();
            if (synced.current !== refreshed || confirmed.current !== refreshed || confirmed.metadata.dev !== original.metadata.dev
              || confirmed.metadata.ino !== original.metadata.ino || confirmed.metadata.mtimeMs !== original.metadata.mtimeMs
              || confirmed.metadata.ctimeMs !== original.metadata.ctimeMs) {
              throw new Error("Google Antigravity credential destination changed during execution.");
            }
            return;
          }
          staged = await openRunnerWorkspaceFile(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          stagedOwned = true;
          pendingStage = { path: stagedPath, directoryDev: owner.dev, directoryIno: owner.ino };
          const created = await staged.stat();
          pendingStage.dev = created.dev; pendingStage.ino = created.ino;
          const replacement = Buffer.from(refreshed);
          let stagedMetadata;
          try {
            let written = 0;
            while (written < replacement.length) {
              const result = await staged.write(replacement, written, replacement.length - written, written);
              if (!result.bytesWritten) throw new Error("Google Antigravity credential copy-back failed.");
              written += result.bytesWritten;
            }
            await staged.sync();
            stagedMetadata = await staged.stat();
            if (!stagedMetadata.isFile() || stagedMetadata.nlink !== 1 || stagedMetadata.uid !== owner.uid
              || (stagedMetadata.mode & 0o777) !== 0o600 || stagedMetadata.size !== replacement.length) {
              throw new Error("Google Antigravity credential staging file is invalid.");
            }
          } finally { replacement.fill(0); }
          await staged.close();
          staged = undefined;
          await assertDirectoryOwner();
          const current = await readDestination();
          if (current.current !== original.current || current.metadata.dev !== original.metadata.dev || current.metadata.ino !== original.metadata.ino
            || current.metadata.mtimeMs !== original.metadata.mtimeMs || current.metadata.ctimeMs !== original.metadata.ctimeMs) {
            throw new Error("Google Antigravity credential destination changed during execution.");
          }
          // Never truncate the selected token. Publish only the fully synced
          // private same-directory file, then make its directory entry durable.
          await rename(stagedPath, destination);
          await directory.sync();
          await assertDirectoryOwner();
          const published = await readDestination();
          if (published.current !== refreshed || published.metadata.dev !== stagedMetadata.dev || published.metadata.ino !== stagedMetadata.ino) {
            throw new Error("Google Antigravity credential destination changed during execution.");
          }
        } finally {
          try {
            if (stagedOwned) await cleanupStage?.();
          } finally {
            try { await staged?.close(); } finally { await directory.close(); }
          }
        }
      });
    },
    remove: async () => {
      const directory = await openRunnerWorkspaceFile(runtimeDirectory, constants.O_RDONLY | constants.O_DIRECTORY)
        .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!directory) return;
      try {
        const metadata = await directory.stat();
        if (!metadata.isDirectory() || metadata.uid !== process.getuid?.()) throw new Error("Google Antigravity credential cleanup home is invalid.");
      } finally { await directory.close(); }
      await Promise.all([TOKEN_FILE, REFRESH_FILE, `${REFRESH_FILE}.tmp`].map(name => rm(join(runtimeDirectory, name), { force: true })));
    },
  };
}

/** Google identity verification can itself rotate a refresh token. Retire the
 * native process before exporting its final token so no live in-memory client
 * can retain an older generation while the connection owner verifies/saves it. */
export function bindAntigravityCredentialTurn(session: NativeSession, input: Parameters<typeof antigravityCredentialTurn>[0]): NativeSession {
  const callbacks = antigravityCredentialTurn(input);
  const close = session.close.bind(session);
  const detach = session.detachControllerForRestart?.bind(session);
  let retirement: Promise<void> | undefined;
  let retired = false;
  let detached = false;
  let copied = false;
  let removed = false;
  let handoffRunning: Promise<void> | undefined;
  let proveRetirement: (() => Promise<void>) | undefined;
  const retryRetirement = async () => {
    if (retired) return;
    if (!proveRetirement) throw new Error("Google Antigravity runtime retirement remains unconfirmed.");
    await proveRetirement();
    retired = true;
  };
  const retain = () => retainGoogleCredentialCleanupForHome(input.managedHome, {
    cleanup: handoff, ...(retired ? {} : { retired: retirement, ...(proveRetirement ? { retryRetirement } : {}) }),
  });
  const retire: NativeSession["close"] = options => retirement ??= Promise.resolve().then(() => close(options)).catch(error => {
    if (error && typeof error === "object") proveRetirement = retirementProofs.get(error);
    // close() may be called before the turn-completion callback. It still
    // owns the same private credential and must keep that account fenced.
    retain();
    throw error;
  });
  session.close = retire;
  if (detach) session.detachControllerForRestart = async () => { detached = true; await detach(); };
  const handoff = (): Promise<void> => handoffRunning ??= (async () => {
    if (detached) return;
    try {
      if (!retired) {
        await retire({ reason: "Google Antigravity subscription credential handoff" });
        retired = true;
      }
      if (!copied) { await callbacks.copyBack(); copied = true; }
      if (!removed) { await callbacks.remove(); removed = true; }
    } catch (error) {
      // Until copy-back succeeds, this private runtime can hold the only valid
      // rotated token. The same account must settle this owner before launch.
      retain();
      throw error;
    }
  })().finally(() => { handoffRunning = undefined; });
  bindManagedNativeCredentialTurn(session, {
    copyBack: handoff,
    remove: async () => {
      if (copied && !removed) { await callbacks.remove(); removed = true; }
    },
  });
  const managedClose = session.close.bind(session);
  session.close = async options => {
    if (detached) return;
    await managedClose(options);
    // The shared turn manager settles a failed turn once. Google retains its
    // failed handoff, so a later close also retries the original private files.
    if (!removed) await handoff();
  };
  return session;
}
