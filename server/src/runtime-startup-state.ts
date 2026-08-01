import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type RuntimeStartupPhase = "booting" | "migrating" | "starting-http";

export type RuntimeStartupState = {
  pid: number;
  phase: RuntimeStartupPhase;
  startedAt: string;
  updatedAt: string;
  databaseLabel?: string | null;
};

const DEFAULT_STARTUP_STATE_RELATIVE_PATH = "Library/Logs/fragno/paperclip-runtime-startup-state.json";

export function resolveRuntimeStartupStatePath(explicitPath?: string | null): string {
  const envPath = explicitPath?.trim() || process.env.PAPERCLIP_RUNTIME_STARTUP_STATE_FILE?.trim();
  if (envPath && envPath.length > 0) {
    return envPath;
  }
  return resolve(homedir(), DEFAULT_STARTUP_STATE_RELATIVE_PATH);
}

export function writeRuntimeStartupState(
  state: RuntimeStartupState,
  explicitPath?: string | null,
): string {
  const path = resolveRuntimeStartupStatePath(explicitPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  return path;
}

export function clearRuntimeStartupState(explicitPath?: string | null): void {
  rmSync(resolveRuntimeStartupStatePath(explicitPath), { force: true });
}

export function readRuntimeStartupState(explicitPath?: string | null): RuntimeStartupState | null {
  const path = resolveRuntimeStartupStatePath(explicitPath);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RuntimeStartupState;
  } catch {
    return null;
  }
}
