import { constants } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeAntigravityCredential, verifyAntigravityCredential } from "../../vendor/paperclip-runner/index.js";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { reconcileRetainedGoogleCleanupForHome, retainGoogleCredentialCleanupForHome, retainGoogleCredentialCleanup, type RetainedGoogleCleanupScope } from "../retained-google-credential-cleanup.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { openRunnerWorkspaceFile } from "./runner-api-files.js";
import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
import { bindManagedNativeCredentialTurn } from "./managed-native-credentials.js";

const AUTH_SECRET = "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET";
const TOKEN_FILE = "acp_token.json";
const REFRESH_FILE = "auth-refresh.json";

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
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("Google Antigravity credential refresh handoff is invalid.");
      }
      const refreshed = sanitizeAntigravityCredential(serialized);
      if (refreshed === input.credential) return;
      const file = await openRunnerWorkspaceFile(destination, constants.O_RDWR);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 65_536) {
          throw new Error("Google Antigravity credential destination is invalid.");
        }
        const bytes = Buffer.alloc(65_537);
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
        // A prior write can succeed before fsync/close reports failure. Only
        // the exact same refresh may confirm that handoff on retry.
        if (current === refreshed) { await file.sync(); return; }
        const replacement = Buffer.from(refreshed);
        let written = 0;
        while (written < replacement.length) {
          const result = await file.write(replacement, written, replacement.length - written, written);
          if (!result.bytesWritten) throw new Error("Google Antigravity credential copy-back failed.");
          written += result.bytesWritten;
        }
        await file.truncate(replacement.length);
        await file.sync();
      } finally { await file.close(); }
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
  const retire: NativeSession["close"] = options => retirement ??= close(options);
  session.close = retire;
  if (detach) session.detachControllerForRestart = async () => { detached = true; await detach(); };
  const handoff = (): Promise<void> => handoffRunning ??= (async () => {
    if (detached) return;
    try {
      await retire({ reason: "Google Antigravity subscription credential handoff" });
      retired = true;
      if (!copied) { await callbacks.copyBack(); copied = true; }
      if (!removed) { await callbacks.remove(); removed = true; }
    } catch (error) {
      // Until copy-back succeeds, this private runtime can hold the only valid
      // rotated token. The same account must settle this owner before launch.
      retainGoogleCredentialCleanupForHome(input.managedHome, {
        cleanup: handoff, ...(retired ? {} : { retired: retirement }),
      });
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
