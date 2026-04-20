import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_PERSISTED_DEV_SERVER_CONTROL_BYTES = 8 * 1024;

export type PersistedDevServerControlRequest = {
  action: "restart";
  requestId: string;
  requestedAt: string | null;
  requestedBy: string | null;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readPersistedDevServerControl(
  env: NodeJS.ProcessEnv = process.env,
): PersistedDevServerControlRequest | null {
  const filePath = env.PAPERCLIP_DEV_SERVER_CONTROL_FILE?.trim();
  if (!filePath || !existsSync(filePath)) return null;

  try {
    if (statSync(filePath).size > MAX_PERSISTED_DEV_SERVER_CONTROL_BYTES) {
      return null;
    }

    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const requestId = normalizeString(raw.requestId);
    if (raw.action !== "restart" || requestId === null) {
      return null;
    }

    return {
      action: "restart",
      requestId,
      requestedAt: normalizeString(raw.requestedAt),
      requestedBy: normalizeString(raw.requestedBy),
    };
  } catch {
    return null;
  }
}

export function writePersistedDevServerControl(
  request: PersistedDevServerControlRequest,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const filePath = env.PAPERCLIP_DEV_SERVER_CONTROL_FILE?.trim();
  if (!filePath) return false;

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return true;
}

export function clearPersistedDevServerControl(env: NodeJS.ProcessEnv = process.env): boolean {
  const filePath = env.PAPERCLIP_DEV_SERVER_CONTROL_FILE?.trim();
  if (!filePath) return false;

  rmSync(filePath, { force: true });
  return true;
}
