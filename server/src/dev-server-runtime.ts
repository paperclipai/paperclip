import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_PERSISTED_DEV_SERVER_RUNTIME_BYTES = 8 * 1024;

export type PersistedDevServerRuntime = {
  requestedPort: number;
  listenPort: number;
  apiUrl: string | null;
  startedAt: string | null;
};

function normalizePort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readPersistedDevServerRuntime(
  env: NodeJS.ProcessEnv = process.env,
): PersistedDevServerRuntime | null {
  const filePath = env.PAPERCLIP_DEV_SERVER_RUNTIME_FILE?.trim();
  if (!filePath || !existsSync(filePath)) return null;

  try {
    if (statSync(filePath).size > MAX_PERSISTED_DEV_SERVER_RUNTIME_BYTES) {
      return null;
    }

    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const requestedPort = normalizePort(raw.requestedPort);
    const listenPort = normalizePort(raw.listenPort);
    if (requestedPort === null || listenPort === null) {
      return null;
    }

    return {
      requestedPort,
      listenPort,
      apiUrl: normalizeString(raw.apiUrl),
      startedAt: normalizeString(raw.startedAt),
    };
  } catch {
    return null;
  }
}

export function writePersistedDevServerRuntime(
  runtime: PersistedDevServerRuntime,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const filePath = env.PAPERCLIP_DEV_SERVER_RUNTIME_FILE?.trim();
  if (!filePath) return false;

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  return true;
}
