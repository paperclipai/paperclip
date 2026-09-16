import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "./config/home.js";

export const PAPERCLIP_RUNTIME_INFO_FILENAME = "runtime-info.json";

export type PaperclipRuntimeInfo = {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  host: string;
  port: number;
  dashboardUrl: string;
  startedAt: string;
};

export function resolveRuntimeInfoPath(instanceId?: string): string {
  return path.join(resolvePaperclipInstanceRoot(instanceId), PAPERCLIP_RUNTIME_INFO_FILENAME);
}

function parseRuntimeInfo(value: unknown): PaperclipRuntimeInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.instanceId !== "string" ||
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.host !== "string" ||
    !Number.isInteger(record.port) ||
    (record.port as number) <= 0 ||
    (record.port as number) > 65_535 ||
    typeof record.dashboardUrl !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return null;
  }
  return record as PaperclipRuntimeInfo;
}

export function readRuntimeInfo(instanceId?: string, filePath = resolveRuntimeInfoPath(instanceId)): PaperclipRuntimeInfo | null {
  try {
    const info = parseRuntimeInfo(JSON.parse(fs.readFileSync(filePath, "utf8")));
    if (!info) return null;
    if (instanceId && info.instanceId !== instanceId) return null;
    return info;
  } catch {
    return null;
  }
}

export function writeRuntimeInfo(
  info: PaperclipRuntimeInfo,
  filePath = resolveRuntimeInfoPath(info.instanceId),
): void {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(info, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function removeRuntimeInfoForPid(
  pid: number,
  instanceId?: string,
  filePath = resolveRuntimeInfoPath(instanceId),
): void {
  const current = readRuntimeInfo(instanceId, filePath);
  if (current?.pid !== pid) return;
  fs.rmSync(filePath, { force: true });
}
