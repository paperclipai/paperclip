import os from "node:os";
import path from "node:path";

type PreparedHermesRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function ensureHermesHome(env: Record<string, string>): string {
  if (typeof env.HERMES_HOME === "string" && env.HERMES_HOME.trim().length > 0) {
    return env.HERMES_HOME.trim();
  }
  // Hermes defaults to ~/.hermes; resolve to whatever HOME points at.
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, ".hermes");
}

/**
 * Prepare environment overlay for a Hermes run. V1 is intentionally minimal:
 * we only set HERMES_HOME explicitly so that downstream tooling (and any
 * future container-side wiring) has an unambiguous path. No tmpdir copying
 * or config injection is performed — Hermes' own headless flags
 * (--accept-hooks --yolo --ignore-rules) cover the same ground.
 */
export async function prepareHermesRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): Promise<PreparedHermesRuntimeConfig> {
  const env = { ...input.env };
  const hermesHome = ensureHermesHome(env);
  if (!env.HERMES_HOME) env.HERMES_HOME = hermesHome;

  return {
    env,
    notes: [],
    cleanup: async () => {},
  };
}
