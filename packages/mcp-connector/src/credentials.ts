import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredCredentials {
  paperclipUrl: string;
  connectorId: string;
  companyId: string;
  credential: string;
}

export function readCredentials(path: string): StoredCredentials | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
  if (
    typeof parsed.paperclipUrl !== "string" ||
    typeof parsed.connectorId !== "string" ||
    typeof parsed.companyId !== "string" ||
    typeof parsed.credential !== "string"
  ) {
    throw new Error(`Credentials file ${path} is malformed`);
  }
  return parsed as StoredCredentials;
}

/** Atomic write with mode 0600: the credential is readable only by the connector's user. */
export function writeCredentials(path: string, credentials: StoredCredentials) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
