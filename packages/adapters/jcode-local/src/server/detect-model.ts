import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

interface ProviderActivityEntry {
  last_used_unix_secs?: number;
}

interface ProviderActivity {
  entries?: Record<string, ProviderActivityEntry>;
}

/**
 * Detect jcode's currently configured default model.
 *
 * Strategy:
 * 1. Try `jcode --quiet model list --json` (most accurate)
 * 2. Fall back to reading ~/.jcode/provider_activity.json for most-recently-used
 */
export async function detectJcodeModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  // Strategy 1: try the CLI
  try {
    const result = await runChildProcess(
      `jcode-detect-${Date.now()}`,
      "jcode",
      ["--quiet", "model", "list", "--json"],
      {
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        timeoutSec: 10,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (!result.timedOut && (result.exitCode ?? 1) === 0 && result.stdout.trim()) {
      const models: Array<{ id: string; label?: string }> = JSON.parse(result.stdout);
      if (Array.isArray(models) && models.length > 0) {
        const candidates = models.map((m) => m.id);
        return {
          model: candidates[0],
          provider: candidates[0].includes("/") ? candidates[0].split("/")[0] : "unknown",
          source: "jcode model list",
          candidates,
        };
      }
    }
  } catch {
    // fall through to Strategy 2
  }

  // Strategy 2: read provider_activity.json
  try {
    const activityPath = path.join(os.homedir(), ".jcode", "provider_activity.json");
    const raw = await fs.readFile(activityPath, "utf-8");
    const activity: ProviderActivity = JSON.parse(raw);
    const entries = activity.entries ?? {};

    // Sort by most recently used
    const sorted = Object.entries(entries)
      .filter(([, v]) => typeof v.last_used_unix_secs === "number")
      .sort(([, a], [, b]) => (b.last_used_unix_secs ?? 0) - (a.last_used_unix_secs ?? 0));

    if (sorted.length > 0) {
      const candidates = sorted.map(([key]) => key);
      const [providerKey] = sorted[0][0].split(":");
      return {
        model: candidates[0],
        provider: providerKey || "unknown",
        source: "~/.jcode/provider_activity.json",
        candidates,
      };
    }
  } catch {
    // no activity file either
  }

  return null;
}
