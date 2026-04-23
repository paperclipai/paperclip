import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TelemetryState } from "./types.js";

export function loadOrCreateState(stateDir: string, version: string): TelemetryState {
  const filePath = path.join(stateDir, "state.json");

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as TelemetryState;
      if (parsed.installId && parsed.salt) {
        return parsed;
      }
    } catch {
      // Corrupted or unreadable state file — fall through and try to recreate.
    }
  }

  const state: TelemetryState = {
    installId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    firstSeenVersion: version,
  };

  // Persistence is best-effort: if the state directory can't be created or
  // written (EACCES / EROFS / out-of-space), still return an in-memory state
  // so telemetry stays a no-op side-channel and never crashes the caller.
  // The ephemeral state regenerates the installId on each process start — an
  // acceptable degradation vs. taking user-facing requests down.
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // Swallow; telemetry must never be load-bearing for request handling.
  }
  return state;
}
