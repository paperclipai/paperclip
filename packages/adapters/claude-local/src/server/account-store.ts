import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ACCOUNT_DIR_MODE = 0o700;
const CREDENTIALS_FILE_NAME = ".credentials.json";

function paperclipHome(): string {
  const explicit = process.env.PAPERCLIP_HOME;
  if (explicit && explicit.trim().length > 0) return explicit;
  return path.join(os.homedir(), ".paperclip");
}

export function accountDir(accountId: string): string {
  return path.join(paperclipHome(), "anthropic-accounts", accountId);
}

export async function provisionOauthAccount(
  accountId: string,
): Promise<{ credentialDir: string }> {
  const credentialDir = accountDir(accountId);
  await fs.mkdir(credentialDir, { recursive: true, mode: ACCOUNT_DIR_MODE });
  await fs.chmod(credentialDir, ACCOUNT_DIR_MODE);
  return { credentialDir };
}

export async function readOauthCredentials(accountId: string): Promise<string | null> {
  const filePath = path.join(accountDir(accountId), CREDENTIALS_FILE_NAME);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function deleteAccountFiles(accountId: string): Promise<void> {
  await fs.rm(accountDir(accountId), { recursive: true, force: true });
}

export type ApiKeyResolver = (secretId: string) => Promise<string>;

let apiKeyResolver: ApiKeyResolver | null = null;

export function setApiKeyResolver(resolver: ApiKeyResolver | null): void {
  apiKeyResolver = resolver;
}

export async function readApiKeyValue(secretId: string): Promise<string> {
  if (!apiKeyResolver) {
    throw new Error(
      "API key resolver is not configured; call setApiKeyResolver() during server bootstrap",
    );
  }
  return apiKeyResolver(secretId);
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: string }).code === "ENOENT";
}
