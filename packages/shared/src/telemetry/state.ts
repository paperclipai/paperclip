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
      // Corrupted state file — recreate
    }
  }

  const state: TelemetryState = {
    installId: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    firstSeenVersion: version,
  };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return state;
}
