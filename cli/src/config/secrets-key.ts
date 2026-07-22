import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PaperclipConfig } from "./schema.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";

export type EnsureSecretsKeyResult =
  | { status: "created"; path: string }
  | { status: "existing"; path: string }
  | { status: "skipped_env"; path: null }
  | { status: "skipped_provider"; path: null };

export function ensureLocalSecretsKeyFile(
  config: Pick<PaperclipConfig, "secrets">,
  configPath?: string,
): EnsureSecretsKeyResult {
  if (config.secrets.provider !== "local_encrypted") {
    return { status: "skipped_provider", path: null };
  }

  const envMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envMasterKey && envMasterKey.trim().length > 0) {
    return { status: "skipped_env", path: null };
  }

  const keyFileOverride = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const configuredPath =
    keyFileOverride && keyFileOverride.trim().length > 0
      ? keyFileOverride.trim()
      : config.secrets.localEncrypted.keyFilePath;
  const keyFilePath = resolveRuntimeLikePath(configuredPath, configPath);

  if (fs.existsSync(keyFilePath)) {
    return { status: "existing", path: keyFilePath };
  }

  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  fs.writeFileSync(keyFilePath, randomBytes(32).toString("base64"), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(keyFilePath, 0o600);
  } catch {
    // best effort
  }
  return { status: "created", path: keyFilePath };
}
