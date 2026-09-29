import fs from "node:fs";
import path from "node:path";

/** Resolve the control-plane database URL without placing a file-backed secret in process.env. */
export function resolveDatabaseConnectionString(input: {
  env?: NodeJS.ProcessEnv;
  configConnectionString?: string | null;
}): string | undefined {
  const env = input.env ?? process.env;
  const filePath = env.PAPERCLIP_DATABASE_URL_FILE?.trim();
  const envUrl = env.DATABASE_URL?.trim();
  const configUrl = input.configConnectionString?.trim();
  if (!filePath) return envUrl || configUrl || undefined;

  if (envUrl || configUrl) {
    throw new Error("PAPERCLIP_DATABASE_URL_FILE cannot be combined with DATABASE_URL or config.database.connectionString");
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error("PAPERCLIP_DATABASE_URL_FILE must be an absolute path");
  }

  let value: string;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error("not a private regular file");
    }
    value = fs.readFileSync(descriptor, "utf8").trim();
  } catch {
    throw new Error("PAPERCLIP_DATABASE_URL_FILE must reference a readable private regular file");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PAPERCLIP_DATABASE_URL_FILE must contain a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error("PAPERCLIP_DATABASE_URL_FILE must contain a PostgreSQL URL");
  }
  return value;
}
