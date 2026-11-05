import fs from "node:fs/promises";
import { isValidLocalEncryptedMasterKey } from "../secrets/local-encrypted-provider.js";

/** Use the same existing vault key as the app for the whole preparation. A
 * missing or replaced file must never cause a new key during publication. */
export async function initializeNativeHarnessPrestageKey(keyFilePath: string, env: NodeJS.ProcessEnv = process.env) {
  const path = env.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim() || keyFilePath;
  const key = env.PAPERCLIP_SECRETS_MASTER_KEY?.trim() || await fs.readFile(path, "utf8");
  if (!isValidLocalEncryptedMasterKey(key)) throw new Error("native_harness_prestage_key_invalid");
  env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path;
  env.PAPERCLIP_SECRETS_MASTER_KEY = key;
}

/** These settings apply to every connection, including later transactions.
 * Existing URL options stay intact; the finite command owns its wait bounds. */
export function nativeHarnessPrestageDatabaseUrl(source: string) {
  const url = new URL(source);
  url.searchParams.set("lock_timeout", "5000");
  url.searchParams.set("statement_timeout", "30000");
  url.searchParams.set("idle_in_transaction_session_timeout", "30000");
  return url.href;
}
