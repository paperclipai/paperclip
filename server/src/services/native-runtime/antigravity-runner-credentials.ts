import { constants } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeAntigravityCredential, verifyAntigravityCredential } from "../../vendor/paperclip-runner/index.js";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
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
}): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-google-recovery-")));
  try {
    const directory = join(home, "antigravity-acp");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, TOKEN_FILE), sanitizeAntigravityCredential(input.refreshedCredential), { flag: "wx", mode: 0o600 });
    return await prepareAntigravityCredentialWriteback({ ...input, managedHome: home });
  } finally { await rm(home, { recursive: true, force: true }); }
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
        if (size > 65_536 || sanitizeAntigravityCredential(bytes.subarray(0, size).toString("utf8")) !== input.credential) {
          throw new Error("Google Antigravity credential destination changed during execution.");
        }
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
  let retirement: Promise<void> | undefined;
  const retire: NativeSession["close"] = options => retirement ??= close(options);
  session.close = retire;
  return bindManagedNativeCredentialTurn(session, {
    copyBack: async () => {
      await retire({ reason: "Google Antigravity subscription credential handoff" });
      try { await callbacks.copyBack(); }
      finally { await callbacks.remove(); }
    },
    remove: callbacks.remove,
  });
}
